package com.agenticform.task;

import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.event.ControlPlaneEventBus;
import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.runtime.RuntimeSession;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;

@Component
public class TaskQueueReconciler {
    private final TaskRepository taskRepository;
    private final AgentRepository agentRepository;
    private final AgentRuntimeRegistry runtimeRegistry;
    private final TaskDependencyService dependencies;
    private final TaskDispatchService dispatch;
    private final ControlPlaneEventBus events;

    public TaskQueueReconciler(TaskRepository taskRepository, AgentRepository agentRepository,
                               AgentRuntimeRegistry runtimeRegistry, TaskDependencyService dependencies,
                               ControlPlaneEventBus events, TaskDispatchService dispatch) {
        this.taskRepository = taskRepository;
        this.agentRepository = agentRepository;
        this.runtimeRegistry = runtimeRegistry;
        this.dependencies = dependencies;
        this.dispatch = dispatch;
        this.events = events;
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.reconcile-delay-ms:10000}")
    public void reconcilePersistedQueue() {
        // Dependency readiness is derived from durable task state. Re-evaluate waiting tasks so a
        // control-plane restart cannot strand a dependent after the prerequisite already terminated.
        for (TaskEntity task : taskRepository.findTop20ByStatusOrderByUpdatedAtAsc(TaskStatus.WAITING_DEPENDENCY)) {
            if (task.getKind() == TaskKind.ORCHESTRATION
                    && task.getLastError() != null
                    && task.getLastError().startsWith("Waiting for delegated tasks")) {
                dispatch.reconcileOrchestration(task.getId());
            } else {
                dependencies.reconcile(task.getId());
            }
        }

        for (TaskEntity task : taskRepository.findTop20ByStatusOrderByUpdatedAtAsc(TaskStatus.DISPATCHED)) {
            if (task.getQueuedSubmissionId() == null) {
                continue;
            }
            agentRepository.findById(task.getAssignedAgentId()).ifPresent(agent -> {
                if (task.getUpdatedAt() != null
                        && task.getUpdatedAt().isBefore(Instant.now().minus(Duration.ofMinutes(2)))
                        && task.getQueuedSubmissionId() != null
                        && task.getId().equals(agent.getActiveTaskId())
                        && agent.getActiveTurnId() == null) {
                    task.setStatus(TaskStatus.BLOCKED);
                    task.setLastError("Runtime accepted dispatch but never started a Codex turn");
                    task.setQueuedSubmissionId(null);
                    taskRepository.save(task);
                    agent.setStatus(agent.getStatus() == AgentStatus.WORKING ? AgentStatus.IDLE : agent.getStatus());
                    agent.setActiveTaskId(null);
                    agent.setActiveTurnId(null);
                    agentRepository.save(agent);
                    events.publish("task.stalled", task.getProjectId(), task.getId());
                    return;
                }
                if (agent.getExecutionNodeId() != null) {
                    updateError(task.getId(), null);
                    return;
                }
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
