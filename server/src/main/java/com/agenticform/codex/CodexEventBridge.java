package com.agenticform.codex;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.message.AgentMessageDeliveryEntity;
import com.agenticform.message.AgentMessageDeliveryRepository;
import com.agenticform.message.AgentMessageService;
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
    private static final String MESSAGE_CLIENT_PREFIX = "agenticform-message:";

    private final CodexJsonRpcClient client;
    private final TaskRepository taskRepository;
    private final AgentRepository agentRepository;
    private final AgentMessageDeliveryRepository messageDeliveries;
    private final AgentMessageService messageService;

    public CodexEventBridge(CodexJsonRpcClient client, TaskRepository taskRepository,
                            AgentRepository agentRepository,
                            AgentMessageDeliveryRepository messageDeliveries,
                            AgentMessageService messageService) {
        this.client = client;
        this.taskRepository = taskRepository;
        this.agentRepository = agentRepository;
        this.messageDeliveries = messageDeliveries;
        this.messageService = messageService;
    }

    @PostConstruct
    void subscribe() { client.addNotificationListener(this::handle); }

    @Transactional
    public void handle(CodexJsonRpcClient.Notification notification) {
        handleInternal(null, 0, notification);
    }

    @Transactional
    public void handleRemote(UUID executionNodeId, long runtimeGeneration,
                             CodexJsonRpcClient.Notification notification) {
        if (executionNodeId == null) throw new IllegalArgumentException("Execution node id is required");
        if (runtimeGeneration <= 0) throw new IllegalArgumentException("Runtime generation is required");
        handleInternal(executionNodeId, runtimeGeneration, notification);
    }

    private void handleInternal(UUID executionNodeId, long runtimeGeneration,
                                CodexJsonRpcClient.Notification notification) {
        JsonNode params = notification.params();
        if (params == null) return;

        if ("item/started".equals(notification.method())) {
            JsonNode item = params.path("item");
            if (!"userMessage".equals(item.path("type").asText())) return;
            String clientId = item.path("clientId").asText("");
            String turnId = params.path("turnId").asText(null);

            UUID taskId = taskId(clientId);
            if (taskId != null) {
                taskRepository.findById(taskId).ifPresent(task -> {
                    if (!authorizedRuntime(executionNodeId, runtimeGeneration, task)) return;
                    task.setCodexTurnId(turnId);
                    task.setStatus(TaskStatus.RUNNING);
                    taskRepository.save(task);
                    agentRepository.findById(task.getAssignedAgentId()).ifPresent(agent -> {
                        if (!authorizedAgent(executionNodeId, runtimeGeneration, agent)) return;
                        agent.setStatus(AgentStatus.WORKING);
                        agent.setActiveTaskId(task.getId());
                        agent.setActiveTurnId(turnId);
                        agentRepository.save(agent);
                    });
                });
                return;
            }

            UUID deliveryId = messageDeliveryId(clientId);
            if (deliveryId != null) {
                messageDeliveries.findById(deliveryId).ifPresent(delivery -> {
                    AgentEntity target = agentRepository.findById(delivery.getToAgentId()).orElse(null);
                    if (!authorizedAgent(executionNodeId, runtimeGeneration, target)) return;
                    delivery.markProcessing(turnId);
                    messageDeliveries.save(delivery);
                    messageService.refreshAggregate(delivery.getMessageId());
                });
            }
            return;
        }

        if ("turn/completed".equals(notification.method())) {
            String turnId = params.path("turn").path("id").asText(null);
            if (turnId == null) return;
            taskRepository.findByCodexTurnId(turnId).ifPresent(task -> {
                if (authorizedRuntime(executionNodeId, runtimeGeneration, task)) {
                    completeTask(task, params, executionNodeId, runtimeGeneration);
                }
            });
            messageDeliveries.findByCodexTurnId(turnId).ifPresent(delivery ->
                    completeMessage(delivery, params, executionNodeId, runtimeGeneration));
        }
    }

    private UUID taskId(String clientId) {
        if (clientId == null || !clientId.startsWith(TASK_CLIENT_PREFIX)) return null;
        String correlation = clientId.substring(TASK_CLIENT_PREFIX.length());
        int generation = correlation.indexOf(":g");
        if (generation >= 0) correlation = correlation.substring(0, generation);
        try { return UUID.fromString(correlation); }
        catch (IllegalArgumentException ignored) { return null; }
    }

    private UUID messageDeliveryId(String clientId) {
        if (clientId == null || !clientId.startsWith(MESSAGE_CLIENT_PREFIX)) return null;
        String correlation = clientId.substring(MESSAGE_CLIENT_PREFIX.length());
        String[] parts = correlation.split(":");
        if (parts.length < 2) return null;
        try { return UUID.fromString(parts[1]); }
        catch (IllegalArgumentException ignored) { return null; }
    }

    private boolean authorizedRuntime(UUID executionNodeId, long generation, TaskEntity task) {
        AgentEntity agent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
        return authorizedAgent(executionNodeId, generation, agent);
    }

    private boolean authorizedAgent(UUID executionNodeId, long generation, AgentEntity agent) {
        if (agent == null) return false;
        if (executionNodeId == null) return agent.getExecutionNodeId() == null;
        return agent.ownsRuntime(executionNodeId, generation);
    }

    private void completeTask(TaskEntity task, JsonNode params, UUID executionNodeId, long generation) {
        AgentEntity agent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
        if (!authorizedAgent(executionNodeId, generation, agent)) return;
        String turnStatus = params.path("turn").path("status").asText();
        task.setStatus("completed".equalsIgnoreCase(turnStatus) ? TaskStatus.COMPLETED : TaskStatus.FAILED);
        taskRepository.save(task);
        agent.setStatus(AgentStatus.IDLE);
        agent.setActiveTaskId(null);
        agent.setActiveTurnId(null);
        agentRepository.save(agent);
    }

    private void completeMessage(AgentMessageDeliveryEntity delivery, JsonNode params,
                                 UUID executionNodeId, long generation) {
        AgentEntity target = agentRepository.findById(delivery.getToAgentId()).orElse(null);
        if (!authorizedAgent(executionNodeId, generation, target)) return;
        String turnStatus = params.path("turn").path("status").asText();
        if ("completed".equalsIgnoreCase(turnStatus)) {
            delivery.markCompleted();
        } else {
            delivery.markProcessingFailed("Recipient Codex turn completed with status " + turnStatus);
        }
        messageDeliveries.save(delivery);
        messageService.refreshAggregate(delivery.getMessageId());
    }
}
