package com.agenticform.codex;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import com.agenticform.task.TaskStatus;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

import java.util.UUID;

@Component
public class CodexEventBridge {
    private static final String TASK_CLIENT_PREFIX = "agenticform-task:";

    private final CodexJsonRpcClient client;
    private final TaskRepository taskRepository;
    private final AgentRepository agentRepository;

    public CodexEventBridge(CodexJsonRpcClient client, TaskRepository taskRepository, AgentRepository agentRepository) {
        this.client = client;
        this.taskRepository = taskRepository;
        this.agentRepository = agentRepository;
    }

    @PostConstruct
    void subscribe() {
        client.addNotificationListener(this::handle);
    }

    @Transactional
    public void handle(CodexJsonRpcClient.Notification notification) {
        JsonNode params = notification.params();
        if (params == null) return;

        if ("item/started".equals(notification.method())) {
            JsonNode item = params.path("item");
            if (!"userMessage".equals(item.path("type").asText())) return;
            String clientId = item.path("clientId").asText("");
            if (!clientId.startsWith(TASK_CLIENT_PREFIX)) return;
            try {
                UUID taskId = UUID.fromString(clientId.substring(TASK_CLIENT_PREFIX.length()));
                taskRepository.findById(taskId).ifPresent(task -> {
                    String turnId = params.path("turnId").asText(null);
                    task.setCodexTurnId(turnId);
                    task.setStatus(TaskStatus.RUNNING);
                    taskRepository.save(task);
                    agentRepository.findById(task.getAssignedAgentId()).ifPresent(agent -> {
                        agent.setStatus(AgentStatus.WORKING);
                        agent.setActiveTaskId(task.getId());
                        agent.setActiveTurnId(turnId);
                        agentRepository.save(agent);
                    });
                });
            } catch (IllegalArgumentException ignored) {
                // Not an Agenticform task correlation id.
            }
            return;
        }

        if ("turn/completed".equals(notification.method())) {
            String turnId = params.path("turn").path("id").asText(null);
            if (turnId == null) return;
            taskRepository.findByCodexTurnId(turnId).ifPresent(task -> completeTask(task, params));
        }
    }

    private void completeTask(TaskEntity task, JsonNode params) {
        String turnStatus = params.path("turn").path("status").asText();
        task.setStatus("completed".equalsIgnoreCase(turnStatus) ? TaskStatus.COMPLETED : TaskStatus.FAILED);
        taskRepository.save(task);

        agentRepository.findById(task.getAssignedAgentId()).ifPresent(agent -> {
            agent.setStatus(AgentStatus.IDLE);
            agent.setActiveTaskId(null);
            agent.setActiveTurnId(null);
            agentRepository.save(agent);
        });
    }
}
