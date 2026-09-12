package com.agenticform.task;

import com.agenticform.agent.AgentRepository;
import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.runtime.RuntimeSession;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class TaskQueueReconciler {
    private final TaskRepository taskRepository;
    private final AgentRepository agentRepository;
    private final AgentRuntimeRegistry runtimeRegistry;
    private final TaskDependencyService dependencies;

    public TaskQueueReconciler(TaskRepository taskRepository, AgentRepository agentRepository,
                               AgentRuntimeRegistry runtimeRegistry, TaskDependencyService dependencies) {
        this.taskRepository = taskRepository;
        this.agentRepository = agentRepository;
        this.runtimeRegistry = runtimeRegistry;
        this.dependencies = dependencies;
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.reconcile-delay-ms:10000}")
    public void reconcilePersistedQueue() {
        // Dependency readiness is derived from durable task state. Re-evaluate waiting tasks so a
        // control-plane restart cannot strand a dependent after the prerequisite already terminated.
        for (TaskEntity task : taskRepository.findTop20ByStatusOrderByUpdatedAtAsc(TaskStatus.WAITING_DEPENDENCY)) {
            dependencies.reconcile(task.getId());
        }

        for (TaskEntity task : taskRepository.findTop20ByStatusOrderByUpdatedAtAsc(TaskStatus.DISPATCHED)) {
            if (task.getQueuedSubmissionId() == null) {
                continue;
            }
            agentRepository.findById(task.getAssignedAgentId()).ifPresent(agent -> {
                try {
                    String sessionId = agent.getRuntimeSessionId();
                    runtimeRegistry.get(agent.getRuntimeType()).resume(new RuntimeSession(sessionId));
                    updateError(task.getId(), null);
                } catch (RuntimeException error) {
                    updateError(task.getId(), "Queue wake/reconcile failed: " + error.getMessage());
                }
            });
        }
    }

    private void updateError(java.util.UUID taskId, String error) {
        // Reload before writing so an item/started notification cannot be overwritten by
        // a stale DISPATCHED entity held by this scheduled reconciliation pass.
        taskRepository.findById(taskId).ifPresent(current -> {
            current.setLastError(error);
            taskRepository.save(current);
        });
    }
}
