package com.agenticform.codex;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.event.ControlPlaneEventBus;
import com.agenticform.message.AgentMessageDeliveryEntity;
import com.agenticform.message.AgentMessageDeliveryRepository;
import com.agenticform.message.AgentMessageService;
import com.agenticform.task.TaskDependencyService;
import com.agenticform.task.TaskDispatchService;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import com.agenticform.task.TaskStatus;
import com.agenticform.runtime.RuntimeType;
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
    private final TaskDependencyService taskDependencies;
    private final TaskDispatchService taskDispatch;
    private final ControlPlaneEventBus events;

    public CodexEventBridge(CodexJsonRpcClient client, TaskRepository taskRepository,
                            AgentRepository agentRepository,
                            AgentMessageDeliveryRepository messageDeliveries,
                            AgentMessageService messageService,
                            TaskDependencyService taskDependencies,
                            TaskDispatchService taskDispatch,
                            ControlPlaneEventBus events) {
        this.client = client;
        this.taskRepository = taskRepository;
        this.agentRepository = agentRepository;
        this.messageDeliveries = messageDeliveries;
        this.messageService = messageService;
        this.taskDependencies = taskDependencies;
        this.taskDispatch = taskDispatch;
        this.events = events;
    }

    @PostConstruct
    void subscribe() { client.addNotificationListener(this::handle); }

    @Transactional
    public void handle(CodexJsonRpcClient.Notification notification) {
        handleInternal(null, 0, null, null, notification);
    }

    @Transactional
    public void handleRemote(UUID executionNodeId, long runtimeGeneration, RuntimeType runtimeType,
                             String runtimeSessionId,
                             CodexJsonRpcClient.Notification notification) {
        if (executionNodeId == null) throw new IllegalArgumentException("Execution node id is required");
        if (runtimeGeneration <= 0) throw new IllegalArgumentException("Runtime generation is required");
        handleInternal(executionNodeId, runtimeGeneration, runtimeType, runtimeSessionId, notification);
    }

    private void handleInternal(UUID executionNodeId, long runtimeGeneration,
                                RuntimeType runtimeType, String runtimeSessionId,
                                CodexJsonRpcClient.Notification notification) {
        JsonNode params = notification.params();
        if (params == null) return;

        if ("item/agentMessage/delta".equals(notification.method())) {
            JsonNode delta = params.path("delta");
            if (!delta.isTextual() || delta.asText().isBlank()) return;
            String threadId = params.path("threadId").asText(null);
            agentRepository.findAll().stream()
                    .filter(agent -> authorizedAgent(executionNodeId, runtimeGeneration, runtimeType, runtimeSessionId, agent))
                    .filter(agent -> threadId != null && threadId.equals(agent.getRuntimeSessionId()))
                    .findFirst().ifPresent(agent -> events.publishRunOutput(agent.getId(), delta.asText()));
            return;
        }

        if ("item/started".equals(notification.method())) {
            JsonNode item = params.path("item");
            if (!"userMessage".equals(item.path("type").asText())) return;
            String clientId = item.path("clientId").asText("");
            String turnId = params.path("turnId").asText(null);

            UUID taskId = taskId(clientId);
            if (taskId != null) {
                taskRepository.findById(taskId).ifPresent(task -> {
                    if (!authorizedRuntime(executionNodeId, runtimeGeneration, runtimeType, runtimeSessionId, task)) return;
                    if (terminal(task.getStatus()) || !matchesTurn(task.getTurnId(), turnId)) return;
                    task.setTurnId(turnId);
                    task.setStatus(TaskStatus.RUNNING);
                    taskRepository.save(task);
                    agentRepository.findById(task.getAssignedAgentId()).ifPresent(agent -> {
                        if (!authorizedAgent(executionNodeId, runtimeGeneration, runtimeType, runtimeSessionId, agent)) return;
                        agent.setStatus(AgentStatus.WORKING);
                        agent.setActiveTaskId(task.getId());
                        agent.setActiveTurnId(turnId);
                        agentRepository.save(agent);
                    });
                    events.publish("task.running", task.getProjectId(), task.getId());
                });
                return;
            }

            UUID deliveryId = messageDeliveryId(clientId);
            if (deliveryId != null) {
                messageDeliveries.findById(deliveryId).ifPresent(delivery -> {
                    AgentEntity target = agentRepository.findById(delivery.getToAgentId()).orElse(null);
                    if (!authorizedAgent(executionNodeId, runtimeGeneration, runtimeType, runtimeSessionId, target)) return;
                    delivery.markProcessing(turnId);
                    messageDeliveries.save(delivery);
                    messageService.refreshAggregate(delivery.getMessageId());
                    if (target != null) {
                        events.publish("message.processing", target.getProjectId(), delivery.getMessageId());
                    }
                });
            }
            return;
        }

        if ("turn/completed".equals(notification.method())) {
            String turnId = params.path("turn").path("id").asText(null);
            if (turnId == null) return;
            taskRepository.findByTurnId(turnId).ifPresent(task -> {
                if (authorizedRuntime(executionNodeId, runtimeGeneration, runtimeType, runtimeSessionId, task)) {
                    completeTask(task, params, executionNodeId, runtimeGeneration, runtimeType, runtimeSessionId);
                }
            });
            messageDeliveries.findByTurnId(turnId).ifPresent(delivery ->
                    completeMessage(delivery, params, executionNodeId, runtimeGeneration, runtimeType, runtimeSessionId));
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

    private boolean authorizedRuntime(UUID executionNodeId, long generation, RuntimeType runtimeType,
                                      String runtimeSessionId, TaskEntity task) {
        AgentEntity agent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
        return authorizedAgent(executionNodeId, generation, runtimeType, runtimeSessionId, agent);
    }

    private boolean authorizedAgent(UUID executionNodeId, long generation, RuntimeType runtimeType,
                                    String runtimeSessionId, AgentEntity agent) {
        if (agent == null) return false;
        if (agent.getStatus() == AgentStatus.STOPPED || agent.getStatus() == AgentStatus.STOPPING) return false;
        if (executionNodeId == null) return agent.getExecutionNodeId() == null;
        return agent.ownsRuntime(executionNodeId, generation, runtimeType, runtimeSessionId);
    }

    private void completeTask(TaskEntity task, JsonNode params, UUID executionNodeId, long generation,
                              RuntimeType runtimeType, String runtimeSessionId) {
        AgentEntity agent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
        String turnId = params.path("turn").path("id").asText(null);
        if (terminal(task.getStatus()) || !matchesTurn(task.getTurnId(), turnId)
                || !authorizedAgent(executionNodeId, generation, runtimeType, runtimeSessionId, agent)) return;
        String turnStatus = params.path("turn").path("status").asText();
        if (task.getStatus() == TaskStatus.BLOCKED) {
            task.setLastError(task.getLastError() == null ? "Agent reported a blocker" : task.getLastError());
        } else if ("completed".equalsIgnoreCase(turnStatus) && (task.getReport() == null || task.getReport().isBlank())) {
            boolean orchestratorWaiting = task.getKind() == com.agenticform.task.TaskKind.ORCHESTRATION
                    && taskDispatch.hasDescendants(task.getId());
            task.setStatus(orchestratorWaiting ? TaskStatus.WAITING_DEPENDENCY : TaskStatus.BLOCKED);
            task.setLastError(orchestratorWaiting
                    ? "Waiting for delegated tasks before orchestrator continuation"
                    : "Agent completed without submitting a task report");
        } else {
            task.setStatus("completed".equalsIgnoreCase(turnStatus) ? TaskStatus.COMPLETED : TaskStatus.FAILED);
        }
        taskRepository.save(task);
        agent.setStatus(AgentStatus.IDLE);
        agent.setActiveTaskId(null);
        agent.setActiveTurnId(null);
        agentRepository.save(agent);
        taskDependencies.reconcileDependents(task.getId());
        taskDispatch.reconcileOrchestrationParents(task.getId());
        events.publish("task.terminal", task.getProjectId(), task.getId());
    }

    private void completeMessage(AgentMessageDeliveryEntity delivery, JsonNode params,
                                 UUID executionNodeId, long generation, RuntimeType runtimeType,
                                 String runtimeSessionId) {
        AgentEntity target = agentRepository.findById(delivery.getToAgentId()).orElse(null);
        if (!authorizedAgent(executionNodeId, generation, runtimeType, runtimeSessionId, target)) return;
        String turnStatus = params.path("turn").path("status").asText();
        if ("completed".equalsIgnoreCase(turnStatus)) {
            delivery.markCompleted();
        } else {
            delivery.markProcessingFailed("Recipient Codex turn completed with status " + turnStatus);
        }
        messageDeliveries.save(delivery);
        messageService.refreshAggregate(delivery.getMessageId());
        if (target != null) {
            events.publish("message.terminal", target.getProjectId(), delivery.getMessageId());
        }
    }

    private boolean terminal(TaskStatus status) {
        return status == TaskStatus.COMPLETED || status == TaskStatus.FAILED || status == TaskStatus.CANCELLED;
    }

    private boolean matchesTurn(String expected, String actual) {
        return actual != null && !actual.isBlank() && (expected == null || expected.isBlank() || expected.equals(actual));
    }
}
