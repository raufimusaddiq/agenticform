package com.agenticform.task;

import com.agenticform.agent.AgentRepository;
import com.agenticform.codex.CodexGateway;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class TaskQueueReconciler {
    private final TaskRepository taskRepository;
    private final AgentRepository agentRepository;
    private final CodexGateway codexGateway;

    public TaskQueueReconciler(TaskRepository taskRepository, AgentRepository agentRepository, CodexGateway codexGateway) {
        this.taskRepository = taskRepository;
        this.agentRepository = agentRepository;
        this.codexGateway = codexGateway;
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.reconcile-delay-ms:10000}")
    public void reconcilePersistedQueue() {
        for (TaskEntity task : taskRepository.findTop20ByStatusOrderByUpdatedAtAsc(TaskStatus.DISPATCHED)) {
            if (task.getCodexQueuedSubmissionId() == null) {
                continue;
            }
            agentRepository.findById(task.getAssignedAgentId()).ifPresent(agent -> {
                try {
                    codexGateway.resumeThread(agent.getCodexThreadId());
                    if (task.getLastError() != null) {
                        task.setLastError(null);
                        taskRepository.save(task);
                    }
                } catch (RuntimeException error) {
                    task.setLastError("Queue wake/reconcile failed: " + error.getMessage());
                    taskRepository.save(task);
                }
            });
        }
    }
}
