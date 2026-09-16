package com.agenticform.task;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRole;
import com.agenticform.message.AgentMessageType;
import org.springframework.stereotype.Service;

import java.util.EnumSet;
import java.util.Set;
import java.util.UUID;

@Service
public class TaskWorkflowGate {
    private static final Set<AgentMessageType> WORK_REQUESTS = EnumSet.of(
            AgentMessageType.REQUEST, AgentMessageType.REVIEW_REQUEST);

    private final TaskRepository tasks;
    private final TaskDependencyService dependencies;

    public TaskWorkflowGate(TaskRepository tasks, TaskDependencyService dependencies) {
        this.tasks = tasks;
        this.dependencies = dependencies;
    }

    public void requireMessageTargetReady(AgentEntity target, AgentMessageType type) {
        if (!requiresRunnableTask(target, type)) return;

        UUID activeTaskId = target.getActiveTaskId();
        if (activeTaskId == null) {
            throw new IllegalStateException("Work-directed messages require a dispatched task; create_task must precede the message");
        }

        TaskEntity task = tasks.findById(activeTaskId)
                .orElseThrow(() -> new IllegalStateException("Target agent active task does not exist: " + activeTaskId));
        if (!target.getId().equals(task.getAssignedAgentId())) {
            throw new IllegalStateException("Target agent active task is assigned to another agent: " + activeTaskId);
        }
        if (task.getStatus() != TaskStatus.DISPATCHED && task.getStatus() != TaskStatus.RUNNING) {
            throw new IllegalStateException("Target task is not runnable: " + task.getStatus());
        }
        requireDependenciesReady(activeTaskId);
    }

    private void requireDependenciesReady(UUID taskId) {
        dependencies.requireReady(taskId);
    }

    private boolean requiresRunnableTask(AgentEntity target, AgentMessageType type) {
        if (type == null) return false;
        if (target.getRole() == AgentRole.OPERATIONAL
                && (type == AgentMessageType.HANDOFF || type == AgentMessageType.REQUEST)) return false;
        if (WORK_REQUESTS.contains(type)) return true;
        return type == AgentMessageType.HANDOFF && target.getRole() != AgentRole.OPERATIONAL;
    }
}
