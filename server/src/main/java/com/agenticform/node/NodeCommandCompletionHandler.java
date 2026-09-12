package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.message.AgentMessageDeliveryEntity;
import com.agenticform.message.AgentMessageDeliveryRepository;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import com.agenticform.task.TaskStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

@Service
public class NodeCommandCompletionHandler {
    private final AgentRepository agents;
    private final TaskRepository tasks;
    private final AgentMessageDeliveryRepository deliveries;
    private final ExecutionNodeService nodes;
    private final ObjectMapper mapper;

    public NodeCommandCompletionHandler(AgentRepository agents, TaskRepository tasks,
                                        AgentMessageDeliveryRepository deliveries,
                                        ExecutionNodeService nodes, ObjectMapper mapper) {
        this.agents = agents;
        this.tasks = tasks;
        this.deliveries = deliveries;
        this.nodes = nodes;
        this.mapper = mapper;
    }

    @Transactional
    public void handle(NodeCommandEntity command, boolean success, String resultJson, String error) {
        try {
            switch (command.getCommandType()) {
                case "START_AGENT" -> completeStart(command, success, resultJson, error);
                case "DISPATCH_TASK" -> completeTaskDispatch(command, success, resultJson, error);
                case "DELIVER_MESSAGE" -> completeMessage(command, success, resultJson, error);
                case "INTERRUPT_TURN" -> completeInterrupt(command, success, error);
                case "CLEANUP_WORKSPACE" -> completeCleanup(command, success, error);
                default -> { }
            }
        } catch (Exception completionError) {
            if (command.getAgentId() != null) {
                agents.findById(command.getAgentId()).ifPresent(agent -> {
                    if (agent.ownsRuntime(command.getNodeId(), command.getRuntimeGeneration())) {
                        agent.setStatus(AgentStatus.DISCONNECTED);
                        agents.save(agent);
                    }
                });
            }
        }
    }

    private void completeStart(NodeCommandEntity command, boolean success, String resultJson, String error) throws Exception {
        if (command.getAgentId() == null) return;
        AgentEntity agent = agents.findById(command.getAgentId()).orElse(null);
        if (agent == null || !agent.ownsRuntime(command.getNodeId(), command.getRuntimeGeneration())) return;
        if (!success) {
            agent.setStatus(AgentStatus.FAILED);
            agents.save(agent);
            return;
        }
        JsonNode result = parse(resultJson);
        String threadId = required(result, "threadId");
        String sourceDirectory = required(result, "sourceDirectory");
        String workingDirectory = required(result, "workingDirectory");
        String branch = result.path("branch").asText(null);
        agent.bindRuntime(command.getRuntimeGeneration(), threadId, sourceDirectory, workingDirectory, branch);
        agents.save(agent);

        JsonNode payload = parse(command.getPayloadJson());
        String recoveryTaskId = payload.path("recoveryTaskId").asText(null);
        if (recoveryTaskId == null || recoveryTaskId.isBlank()) return;
        TaskEntity task = tasks.findById(UUID.fromString(recoveryTaskId)).orElse(null);
        if (task == null || terminal(task.getStatus())) return;

        String clientMessageId = "agenticform-task:" + task.getId() + ":g" + command.getRuntimeGeneration();
        NodeCommandEntity dispatch = nodes.enqueue(command.getNodeId(), agent.getId(), "DISPATCH_TASK",
                "dispatch-task:" + task.getId() + ":g" + command.getRuntimeGeneration(), Map.of(
                        "taskId", task.getId().toString(),
                        "threadId", threadId,
                        "clientMessageId", clientMessageId,
                        "prompt", task.getPrompt()));
        task.setCodexQueuedSubmissionId("node-command:" + dispatch.getId());
        task.setCodexTurnId(null);
        task.setStatus(TaskStatus.DISPATCHED);
        task.setLastError(null);
        tasks.save(task);
        agent.setStatus(AgentStatus.WORKING);
        agent.setActiveTaskId(task.getId());
        agent.setActiveTurnId(null);
        agents.save(agent);
    }

    private void completeTaskDispatch(NodeCommandEntity command, boolean success, String resultJson, String error) throws Exception {
        JsonNode payload = parse(command.getPayloadJson());
        UUID taskId = UUID.fromString(required(payload, "taskId"));
        TaskEntity task = tasks.findById(taskId).orElse(null);
        if (task == null) return;
        AgentEntity agent = agents.findById(task.getAssignedAgentId()).orElse(null);
        if (agent == null || !agent.ownsRuntime(command.getNodeId(), command.getRuntimeGeneration())) return;
        if (!success) {
            task.setStatus(TaskStatus.BLOCKED);
            task.setLastError(error == null || error.isBlank() ? "Remote task dispatch failed" : error);
            tasks.save(task);
            agent.setStatus(AgentStatus.DISCONNECTED);
            agent.setActiveTaskId(null);
            agent.setActiveTurnId(null);
            agents.save(agent);
            return;
        }
        JsonNode result = parse(resultJson);
        String queueId = result.path("queuedSubmissionId").asText(null);
        String turnId = result.path("turnId").asText(null);
        if (queueId != null && !queueId.isBlank()) task.setCodexQueuedSubmissionId(queueId);
        if (turnId != null && !turnId.isBlank()) {
            task.setCodexTurnId(turnId);
            task.setStatus(TaskStatus.RUNNING);
        } else {
            task.setStatus(TaskStatus.DISPATCHED);
        }
        task.setLastError(null);
        tasks.save(task);
        if (turnId != null && !turnId.isBlank()) {
            agent.setStatus(AgentStatus.WORKING);
            agent.setActiveTaskId(task.getId());
            agent.setActiveTurnId(turnId);
            agents.save(agent);
        }
    }

    private void completeMessage(NodeCommandEntity command, boolean success, String resultJson, String error) throws Exception {
        String[] parts = command.getIdempotencyKey().split(":");
        if (parts.length < 3 || !"message".equals(parts[0])) return;
        UUID messageId = UUID.fromString(parts[1]);
        UUID agentId = UUID.fromString(parts[2]);
        AgentEntity agent = agents.findById(agentId).orElse(null);
        if (agent == null || !agent.ownsRuntime(command.getNodeId(), command.getRuntimeGeneration())) return;
        AgentMessageDeliveryEntity delivery = deliveries.findByMessageIdAndToAgentId(messageId, agentId).orElse(null);
        if (delivery == null) return;
        if (!success) {
            delivery.markFailed(error == null || error.isBlank() ? "Remote message delivery failed" : error);
        } else {
            JsonNode result = parse(resultJson);
            delivery.markDispatched(result.path("queuedSubmissionId").asText(null), result.path("turnId").asText(null));
        }
        deliveries.save(delivery);
    }

    private void completeInterrupt(NodeCommandEntity command, boolean success, String error) throws Exception {
        if (command.getAgentId() == null) return;
        AgentEntity agent = agents.findById(command.getAgentId()).orElse(null);
        if (agent == null || !agent.ownsRuntime(command.getNodeId(), command.getRuntimeGeneration())) return;
        JsonNode payload = parse(command.getPayloadJson());
        if (!payload.path("stopLifecycle").asBoolean(false)) return;
        if (!success) {
            agent.setStatus(AgentStatus.DISCONNECTED);
            agents.save(agent);
            return;
        }
        if (payload.path("cleanupAfterInterrupt").asBoolean(false)) {
            Map<String, Object> cleanup = new LinkedHashMap<>();
            cleanup.put("threadId", agent.getCodexThreadId() == null ? "" : agent.getCodexThreadId());
            cleanup.put("defaultBranch", payload.path("defaultBranch").asText(""));
            cleanup.put("stopLifecycle", true);
            nodes.enqueue(command.getNodeId(), agent.getId(), "CLEANUP_WORKSPACE",
                    "stop-cleanup:" + agent.getId() + ":g" + command.getRuntimeGeneration(), cleanup);
            return;
        }
        if (payload.path("finalizeStop").asBoolean(false)) {
            agent.setStatus(AgentStatus.STOPPED);
            agent.setActiveTaskId(null);
            agent.setActiveTurnId(null);
            agents.save(agent);
        }
    }

    private void completeCleanup(NodeCommandEntity command, boolean success, String error) throws Exception {
        if (command.getAgentId() == null) return;
        AgentEntity agent = agents.findById(command.getAgentId()).orElse(null);
        if (agent == null || !agent.ownsRuntime(command.getNodeId(), command.getRuntimeGeneration())) return;
        JsonNode payload = parse(command.getPayloadJson());
        boolean stopLifecycle = payload.path("stopLifecycle").asBoolean(false)
                || command.getIdempotencyKey().startsWith("stop-cleanup:");
        if (stopLifecycle) {
            // Workspace cleanup is an optimization, not permission to discard unmerged work.
            // Even if cleanup is refused because the branch is dirty/unmerged, the agent runtime
            // is logically stopped and the retained workspace remains available for recovery.
            agent.setStatus(AgentStatus.STOPPED);
            agent.setActiveTaskId(null);
            agent.setActiveTurnId(null);
            agents.save(agent);
            return;
        }
        if (success) {
            agent.setStatus(AgentStatus.STOPPED);
            agent.setActiveTaskId(null);
            agent.setActiveTurnId(null);
        } else {
            // Cleanup can be refused for a dirty/unmerged worktree while the node/runtime are still healthy.
            // Keep the runtime connected and paused so the operator/agent can resolve the workspace and retry.
            agent.setStatus(AgentStatus.IDLE);
        }
        agents.save(agent);
    }

    private boolean terminal(TaskStatus status) {
        return status == TaskStatus.COMPLETED || status == TaskStatus.CANCELLED || status == TaskStatus.FAILED;
    }

    private JsonNode parse(String json) throws Exception {
        return mapper.readTree(json == null || json.isBlank() ? "{}" : json);
    }

    private String required(JsonNode node, String field) {
        String value = node.path(field).asText(null);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Missing node command result field: " + field);
        return value;
    }
}
