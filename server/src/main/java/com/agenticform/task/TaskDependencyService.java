package com.agenticform.task;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.UUID;

@Service
public class TaskDependencyService {
    private static final String DEPENDENCY_BLOCK_PREFIX = "Dependency failed:";
    private static final String INFRASTRUCTURE_BLOCK_PREFIX = "Execution node was lost";

    private final TaskRepository tasks;
    private final TaskDependencyRepository dependencies;

    public TaskDependencyService(TaskRepository tasks, TaskDependencyRepository dependencies) {
        this.tasks = tasks;
        this.dependencies = dependencies;
    }

    public List<TaskDependencyEntity> list(UUID taskId) {
        requireTask(taskId);
        return dependencies.findAllByTaskId(taskId);
    }

    @Transactional
    public TaskDependencyEntity add(UUID taskId, UUID dependsOnTaskId, TaskDependencyType type) {
        TaskEntity task = requireTask(taskId);
        TaskEntity prerequisite = requireTask(dependsOnTaskId);
        if (taskId.equals(dependsOnTaskId)) throw new IllegalArgumentException("Task cannot depend on itself");
        if (!task.getProjectId().equals(prerequisite.getProjectId())) {
            throw new IllegalArgumentException("Task dependencies must stay within one project");
        }
        requireMutableDependencies(task);
        if (dependencies.existsByTaskIdAndDependsOnTaskId(taskId, dependsOnTaskId)) {
            throw new IllegalArgumentException("Task dependency already exists");
        }
        if (wouldCreateCycle(taskId, dependsOnTaskId)) {
            throw new IllegalArgumentException("Task dependency would create a cycle");
        }

        TaskDependencyEntity dependency = dependencies.save(new TaskDependencyEntity(
                taskId, dependsOnTaskId, type == null ? TaskDependencyType.REQUIRES_SUCCESS : type));
        reconcile(taskId);
        return dependency;
    }

    @Transactional
    public void remove(UUID taskId, UUID dependsOnTaskId) {
        TaskEntity task = requireTask(taskId);
        requireMutableDependencies(task);
        dependencies.deleteById(new TaskDependencyId(taskId, dependsOnTaskId));
        reconcile(taskId);
    }

    @Transactional
    public Evaluation reconcile(UUID taskId) {
        TaskEntity task = requireTask(taskId);
        Evaluation evaluation = evaluate(taskId);
        boolean becameDependencyBlocked = false;
        if (isPreDispatchDependencyState(task)) {
            boolean wasDependencyBlocked = task.getStatus() == TaskStatus.BLOCKED && isDependencyBlock(task);
            boolean wasWaiting = task.getStatus() == TaskStatus.WAITING_DEPENDENCY;
            switch (evaluation.state()) {
                case READY -> {
                    task.setStatus(TaskStatus.READY);
                    if (wasDependencyBlocked || wasWaiting) task.setLastError(null);
                }
                case WAITING -> {
                    task.setStatus(TaskStatus.WAITING_DEPENDENCY);
                    task.setLastError(evaluation.reason());
                }
                case BLOCKED -> {
                    task.setStatus(TaskStatus.BLOCKED);
                    task.setLastError(DEPENDENCY_BLOCK_PREFIX + " " + evaluation.reason());
                    becameDependencyBlocked = !wasDependencyBlocked;
                }
            }
            tasks.save(task);
        }
        if (becameDependencyBlocked) {
            // A task blocked by an unsatisfied prerequisite is terminal from the dependency graph's
            // perspective. Propagate that outcome so deeper dependents never wait forever.
            reconcileDependents(taskId);
        }
        return evaluation;
    }

    @Transactional
    public void reconcileDependents(UUID upstreamTaskId) {
        for (TaskDependencyEntity edge : dependencies.findAllByDependsOnTaskId(upstreamTaskId)) {
            reconcile(edge.getTaskId());
        }
    }

    public Evaluation evaluate(UUID taskId) {
        requireTask(taskId);
        List<TaskDependencyEntity> edges = dependencies.findAllByTaskId(taskId);
        if (edges.isEmpty()) return new Evaluation(State.READY, null);

        for (TaskDependencyEntity edge : edges) {
            TaskEntity prerequisite = tasks.findById(edge.getDependsOnTaskId()).orElse(null);
            if (prerequisite == null) {
                return new Evaluation(State.BLOCKED, "missing prerequisite " + edge.getDependsOnTaskId());
            }

            switch (edge.getDependencyType()) {
                case BLOCKS, REQUIRES_COMPLETION -> {
                    if (!isDependencyTerminal(prerequisite)) {
                        return new Evaluation(State.WAITING, "waiting for " + prerequisite.getId());
                    }
                }
                case REQUIRES_SUCCESS -> {
                    if (prerequisite.getStatus() == TaskStatus.COMPLETED) continue;
                    // A task blocked by infrastructure loss is terminal from the graph's
                    // perspective; it can no longer reach COMPLETED, so dependents must
                    // fail fast instead of waiting forever for an outcome that cannot happen.
                    if (prerequisite.getStatus() == TaskStatus.BLOCKED
                            && prerequisite.getLastError() != null
                            && prerequisite.getLastError().startsWith(INFRASTRUCTURE_BLOCK_PREFIX)) {
                        return new Evaluation(State.BLOCKED,
                                prerequisite.getId() + " ended as " + prerequisite.getStatus());
                    }
                    if (isDependencyFailure(prerequisite)) {
                        return new Evaluation(State.BLOCKED,
                                prerequisite.getId() + " ended as " + prerequisite.getStatus());
                    }
                    return new Evaluation(State.WAITING,
                            "waiting for successful completion of " + prerequisite.getId());
                }
            }
        }
        return new Evaluation(State.READY, null);
    }

    public boolean dispatchable(UUID taskId) {
        return evaluate(taskId).state() == State.READY;
    }

    public void requireReady(UUID taskId) {
        Evaluation evaluation = evaluate(taskId);
        if (evaluation.state() != State.READY) {
            throw new IllegalStateException("Task dependencies are not satisfied: " + evaluation.reason());
        }
    }

    private boolean wouldCreateCycle(UUID taskId, UUID dependsOnTaskId) {
        ArrayDeque<UUID> pending = new ArrayDeque<>();
        Set<UUID> visited = new HashSet<>();
        pending.add(dependsOnTaskId);
        while (!pending.isEmpty()) {
            UUID current = pending.removeFirst();
            if (!visited.add(current)) continue;
            if (current.equals(taskId)) return true;
            dependencies.findAllByTaskId(current).forEach(edge -> pending.addLast(edge.getDependsOnTaskId()));
        }
        return false;
    }

    private void requireMutableDependencies(TaskEntity task) {
        if (task.getStatus() != TaskStatus.READY && task.getStatus() != TaskStatus.WAITING_DEPENDENCY
                && !(task.getStatus() == TaskStatus.BLOCKED && isDependencyBlock(task))) {
            throw new IllegalStateException("Dependencies can only change before task dispatch");
        }
    }

    private boolean isPreDispatchDependencyState(TaskEntity task) {
        return task.getStatus() == TaskStatus.READY
                || task.getStatus() == TaskStatus.WAITING_DEPENDENCY
                || (task.getStatus() == TaskStatus.BLOCKED && isDependencyBlock(task));
    }

    private boolean isDependencyBlock(TaskEntity task) {
        return task.getLastError() != null && task.getLastError().startsWith(DEPENDENCY_BLOCK_PREFIX);
    }

    private boolean isDependencyTerminal(TaskEntity task) {
        return task.getStatus() == TaskStatus.COMPLETED
                || task.getStatus() == TaskStatus.FAILED
                || task.getStatus() == TaskStatus.CANCELLED
                || (task.getStatus() == TaskStatus.BLOCKED && isDependencyBlock(task));
    }

    private boolean isDependencyFailure(TaskEntity task) {
        return task.getStatus() == TaskStatus.FAILED
                || task.getStatus() == TaskStatus.CANCELLED
                || (task.getStatus() == TaskStatus.BLOCKED && isDependencyBlock(task));
    }

    private TaskEntity requireTask(UUID taskId) {
        return tasks.findById(taskId).orElseThrow(() -> new NoSuchElementException("Task not found: " + taskId));
    }

    public record DependencyRequest(UUID taskId, TaskDependencyType type) {}
    public record Evaluation(State state, String reason) {}
    public enum State { READY, WAITING, BLOCKED }
}
