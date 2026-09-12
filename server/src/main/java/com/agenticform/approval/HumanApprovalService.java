package com.agenticform.approval;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.codex.CodexJsonRpcClient;
import com.agenticform.node.RemoteCodexInteractionService;
import com.agenticform.node.RemoteInteractionContext;
import com.agenticform.policy.PolicyEffect;
import com.agenticform.policy.PolicyPreauthorizationService;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class HumanApprovalService {
    private final HumanApprovalRepository repository;
    private final AgentRepository agentRepository;
    private final HumanApprovalPolicy policy;
    private final PolicyPreauthorizationService preauthorizations;
    private final RemoteInteractionContext remoteContext;
    private final RemoteCodexInteractionService remoteInteractions;
    private final ObjectMapper mapper;
    private final Map<UUID, CompletableFuture<JsonNode>> pendingResponses = new ConcurrentHashMap<>();

    public HumanApprovalService(HumanApprovalRepository repository, AgentRepository agentRepository,
                                HumanApprovalPolicy policy, PolicyPreauthorizationService preauthorizations,
                                RemoteInteractionContext remoteContext,
                                RemoteCodexInteractionService remoteInteractions,
                                ObjectMapper mapper) {
        this.repository = repository;
        this.agentRepository = agentRepository;
        this.policy = policy;
        this.preauthorizations = preauthorizations;
        this.remoteContext = remoteContext;
        this.remoteInteractions = remoteInteractions;
        this.mapper = mapper;
    }

    @PostConstruct
    void recoverOrphanedRequests() {
        for (HumanApprovalEntity approval : repository.findAllByStatus(HumanApprovalStatus.PENDING)) {
            if (approval.getRemoteInteractionId() != null) {
                // Remote interactions are durable. The execution node can reconnect and poll the
                // stored interaction after this control plane restarts.
                continue;
            }
            approval.orphan();
            repository.save(approval);
            agentRepository.findById(approval.getAgentId()).ifPresent(agent -> {
                if (agent.getStatus() == AgentStatus.WAITING_APPROVAL) {
                    agent.setStatus(AgentStatus.DISCONNECTED);
                    agentRepository.save(agent);
                }
            });
        }
    }

    public List<HumanApprovalEntity> list(UUID projectId, HumanApprovalStatus status) {
        if (projectId != null && status != null) {
            return repository.findAllByProjectIdAndStatusOrderByCreatedAtDesc(projectId, status);
        }
        if (projectId != null) return repository.findAllByProjectIdOrderByCreatedAtDesc(projectId);
        if (status != null) return repository.findAllByStatusOrderByCreatedAtDesc(status);
        return repository.findAllByOrderByCreatedAtDesc();
    }

    public CompletionStage<JsonNode> receive(CodexJsonRpcClient.ServerRequest request) {
        JsonNode params = request.params();
        String threadId = requiredText(params, "threadId");
        AgentEntity agent = agentRepository.findByCodexThreadId(threadId)
                .orElseThrow(() -> new NoSuchElementException("No Agenticform agent owns Codex thread " + threadId));

        HumanApprovalType type = typeForMethod(request.method());
        HumanApprovalPolicy.Evaluation evaluation = policy.evaluate(agent, type, params);
        HumanApprovalEntity approval = createApproval(request, agent, type, request.method(), params, evaluation);

        if (evaluation.effect() == PolicyEffect.REQUIRE_HUMAN && type != HumanApprovalType.USER_INPUT) {
            UUID grantId = preauthorizations.consume(
                    agent.getId(), agent.getActiveTaskId(), evaluation.action(), evaluation.environment());
            if (grantId != null) {
                approval.attachPreauthorizationGrant(grantId);
                JsonNode response = automaticResponse(type, params);
                approval.resolve(HumanApprovalStatus.PREAUTHORIZED, toJson(response));
                repository.save(approval);
                return CompletableFuture.completedFuture(response);
            }
        }

        return applyDecision(approval, agent, type, params, evaluation);
    }

    public CompletionStage<JsonNode> receiveProtectedAction(CodexJsonRpcClient.ServerRequest request,
                                                              AgentEntity agent,
                                                              JsonNode arguments) {
        HumanApprovalPolicy.Evaluation evaluation = policy.evaluate(agent, HumanApprovalType.PROTECTED_ACTION, arguments);
        HumanApprovalEntity approval = createApproval(request, agent, HumanApprovalType.PROTECTED_ACTION,
                "agenticform/request_protected_action", arguments, evaluation);
        return applyDecision(approval, agent, HumanApprovalType.PROTECTED_ACTION, arguments, evaluation);
    }

    public CompletionStage<JsonNode> receiveDeclaredAction(CodexJsonRpcClient.ServerRequest request,
                                                             AgentEntity agent,
                                                             JsonNode arguments) {
        HumanApprovalPolicy.Evaluation evaluation = policy.evaluateDeclaredAction(agent, arguments);
        HumanApprovalEntity approval = createApproval(request, agent, HumanApprovalType.PROTECTED_ACTION,
                "agenticform/request_action", arguments, evaluation);
        return applyDecision(approval, agent, HumanApprovalType.PROTECTED_ACTION, arguments, evaluation);
    }

    private HumanApprovalEntity createApproval(CodexJsonRpcClient.ServerRequest request,
                                                AgentEntity agent,
                                                HumanApprovalType type,
                                                String method,
                                                JsonNode payload,
                                                HumanApprovalPolicy.Evaluation evaluation) {
        HumanApprovalStatus initialStatus = switch (evaluation.effect()) {
            case ALLOW -> HumanApprovalStatus.AUTO_APPROVED;
            case REQUIRE_HUMAN -> HumanApprovalStatus.PENDING;
            case DENY -> HumanApprovalStatus.POLICY_DENIED;
        };

        HumanApprovalEntity approval = new HumanApprovalEntity(
                agent.getProjectId(), agent.getId(), requestId(request.id()), method, type,
                agent.getHumanControlMode(), evaluation.risk(), initialStatus,
                requiredText(request.params(), "threadId"), nullableText(request.params(), "turnId"),
                nullableText(request.params(), "itemId"), evaluation.summary(), toJson(payload));
        approval.attachPolicy(evaluation.action(), evaluation.environment(), evaluation.effect(),
                evaluation.configuredDecision().matchedRuleId());
        UUID remoteInteractionId = remoteContext.currentInteractionId();
        if (remoteInteractionId != null) approval.attachRemoteInteraction(remoteInteractionId);
        return approval;
    }

    private CompletionStage<JsonNode> applyDecision(HumanApprovalEntity approval,
                                                     AgentEntity agent,
                                                     HumanApprovalType type,
                                                     JsonNode params,
                                                     HumanApprovalPolicy.Evaluation evaluation) {
        if (evaluation.effect() == PolicyEffect.ALLOW) {
            JsonNode response = automaticResponse(type, params);
            approval.resolve(HumanApprovalStatus.AUTO_APPROVED, toJson(response));
            repository.save(approval);
            return CompletableFuture.completedFuture(response);
        }
        if (evaluation.effect() == PolicyEffect.DENY) {
            JsonNode response = policyDeniedResponse(type);
            approval.resolve(HumanApprovalStatus.POLICY_DENIED, toJson(response));
            repository.save(approval);
            return CompletableFuture.completedFuture(response);
        }
        return waitForHuman(approval, agent);
    }

    private CompletionStage<JsonNode> waitForHuman(HumanApprovalEntity approval, AgentEntity agent) {
        approval = repository.save(approval);
        agent.setStatus(AgentStatus.WAITING_APPROVAL);
        agentRepository.save(agent);

        CompletableFuture<JsonNode> response = new CompletableFuture<>();
        pendingResponses.put(approval.getId(), response);
        return response;
    }

    public synchronized HumanApprovalEntity decide(UUID approvalId, HumanApprovalDecision decision) {
        HumanApprovalEntity approval = pending(approvalId);
        if (approval.getType() == HumanApprovalType.USER_INPUT) {
            throw new IllegalStateException("User input requests must be answered, not approved");
        }

        HumanApprovalDecision effectiveDecision = approval.getPolicyEffect() == PolicyEffect.REQUIRE_HUMAN
                && decision == HumanApprovalDecision.APPROVE_SESSION
                ? HumanApprovalDecision.APPROVE_ONCE : decision;

        if (effectiveDecision == HumanApprovalDecision.APPROVE_ONCE
                && approval.getType() == HumanApprovalType.PROTECTED_ACTION
                && approval.getPolicyEffect() == PolicyEffect.REQUIRE_HUMAN) {
            UUID grantId = preauthorizations.issue(
                    approval.getAgentId(),
                    agentRepository.findById(approval.getAgentId()).map(AgentEntity::getActiveTaskId).orElse(null),
                    approval.getPolicyAction(), approval.getPolicyEnvironment());
            approval.attachPreauthorizationGrant(grantId);
        }

        JsonNode response = decisionResponse(approval, effectiveDecision);
        HumanApprovalStatus status = switch (effectiveDecision) {
            case APPROVE_ONCE -> HumanApprovalStatus.APPROVED;
            case APPROVE_SESSION -> HumanApprovalStatus.APPROVED_FOR_SESSION;
            case DECLINE -> HumanApprovalStatus.DECLINED;
            case CANCEL -> HumanApprovalStatus.CANCELLED;
        };
        resolvePending(approval, status, response);
        return approval;
    }

    public synchronized HumanApprovalEntity answer(UUID approvalId, Map<String, List<String>> answers) {
        HumanApprovalEntity approval = pending(approvalId);
        if (approval.getType() != HumanApprovalType.USER_INPUT) {
            throw new IllegalStateException("Only user input requests accept answers");
        }

        ObjectNode response = mapper.createObjectNode();
        ObjectNode answerMap = response.putObject("answers");
        answers.forEach((questionId, values) -> {
            ObjectNode answer = answerMap.putObject(questionId);
            var rows = answer.putArray("answers");
            values.forEach(rows::add);
        });
        resolvePending(approval, HumanApprovalStatus.ANSWERED, response);
        return approval;
    }

    private HumanApprovalEntity pending(UUID approvalId) {
        HumanApprovalEntity approval = repository.findById(approvalId)
                .orElseThrow(() -> new NoSuchElementException("Approval not found: " + approvalId));
        if (approval.getStatus() != HumanApprovalStatus.PENDING) {
            throw new IllegalStateException("Approval is not pending: " + approval.getStatus());
        }
        if (approval.getRemoteInteractionId() == null && !pendingResponses.containsKey(approvalId)) {
            approval.orphan();
            repository.save(approval);
            throw new IllegalStateException("Local Codex request is no longer attached; wait for the request to be replayed");
        }
        return approval;
    }

    private void resolvePending(HumanApprovalEntity approval, HumanApprovalStatus status, JsonNode response) {
        CompletableFuture<JsonNode> future = pendingResponses.remove(approval.getId());
        if (approval.getRemoteInteractionId() == null && future == null) {
            approval.orphan();
            repository.save(approval);
            throw new IllegalStateException("Local Codex request is no longer attached");
        }

        approval.resolve(status, toJson(response));
        repository.save(approval);
        restoreAgentStatus(approval.getAgentId());
        if (approval.getRemoteInteractionId() != null) {
            remoteInteractions.ready(approval.getRemoteInteractionId(), response);
        }
        if (future != null) future.complete(response);
    }

    private void restoreAgentStatus(UUID agentId) {
        if (repository.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)) return;
        agentRepository.findById(agentId).ifPresent(agent -> {
            agent.setStatus(agent.getActiveTurnId() == null ? AgentStatus.IDLE : AgentStatus.WORKING);
            agentRepository.save(agent);
        });
    }

    private JsonNode automaticResponse(HumanApprovalType type, JsonNode params) {
        ObjectNode response = mapper.createObjectNode();
        if (type == HumanApprovalType.COMMAND_EXECUTION || type == HumanApprovalType.FILE_CHANGE) {
            response.put("decision", "accept");
            return response;
        }
        if (type == HumanApprovalType.PERMISSIONS) {
            response.set("permissions", params.path("permissions").deepCopy());
            response.put("scope", "turn");
            return response;
        }
        if (type == HumanApprovalType.PROTECTED_ACTION) {
            return policyToolResponse(true,
                    "Policy allows this action. Proceed only with the declared action and environment.");
        }
        throw new IllegalStateException("No automatic response is defined for " + type);
    }

    private JsonNode policyDeniedResponse(HumanApprovalType type) {
        if (type == HumanApprovalType.COMMAND_EXECUTION || type == HumanApprovalType.FILE_CHANGE) {
            ObjectNode response = mapper.createObjectNode();
            response.put("decision", "decline");
            return response;
        }
        if (type == HumanApprovalType.PERMISSIONS) {
            ObjectNode response = mapper.createObjectNode();
            response.putObject("permissions");
            response.put("scope", "turn");
            return response;
        }
        if (type == HumanApprovalType.USER_INPUT) {
            ObjectNode response = mapper.createObjectNode();
            response.putObject("answers");
            return response;
        }
        if (type == HumanApprovalType.PROTECTED_ACTION) {
            return policyToolResponse(false,
                    "Policy denied this action. Do not execute it; choose an allowed alternative or report the blocker.");
        }
        throw new IllegalStateException("No policy-denied response is defined for " + type);
    }

    private JsonNode decisionResponse(HumanApprovalEntity approval, HumanApprovalDecision decision) {
        JsonNode params = readJson(approval.getRequestPayload());
        ObjectNode response = mapper.createObjectNode();

        if (approval.getType() == HumanApprovalType.COMMAND_EXECUTION
                || approval.getType() == HumanApprovalType.FILE_CHANGE) {
            response.put("decision", switch (decision) {
                case APPROVE_ONCE -> "accept";
                case APPROVE_SESSION -> "acceptForSession";
                case DECLINE -> "decline";
                case CANCEL -> "cancel";
            });
            return response;
        }

        if (approval.getType() == HumanApprovalType.PERMISSIONS) {
            if (decision == HumanApprovalDecision.APPROVE_ONCE || decision == HumanApprovalDecision.APPROVE_SESSION) {
                response.set("permissions", params.path("permissions").deepCopy());
                response.put("scope", decision == HumanApprovalDecision.APPROVE_SESSION ? "session" : "turn");
            } else {
                response.putObject("permissions");
                response.put("scope", "turn");
            }
            return response;
        }

        if (approval.getType() == HumanApprovalType.PROTECTED_ACTION) {
            boolean approved = decision == HumanApprovalDecision.APPROVE_ONCE
                    || decision == HumanApprovalDecision.APPROVE_SESSION;
            return policyToolResponse(approved, approved
                    ? "Human approved this policy-governed action once. Proceed with exactly the declared action; a matching native Codex approval may consume the one-shot preauthorization without asking again."
                    : "Human declined this policy-governed action. Do not execute it; find an allowed alternative or report the blocker.");
        }

        throw new IllegalStateException("Unsupported approval type: " + approval.getType());
    }

    private JsonNode policyToolResponse(boolean allowed, String text) {
        ObjectNode response = mapper.createObjectNode();
        response.put("success", true);
        ArrayNode items = response.putArray("contentItems");
        ObjectNode item = items.addObject();
        item.put("type", "inputText");
        item.put("text", "{\"allowed\":" + allowed + ",\"message\":\"" + escapeJson(text) + "\"}");
        return response;
    }

    private String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private HumanApprovalType typeForMethod(String method) {
        return switch (method) {
            case "item/commandExecution/requestApproval" -> HumanApprovalType.COMMAND_EXECUTION;
            case "item/fileChange/requestApproval" -> HumanApprovalType.FILE_CHANGE;
            case "item/permissions/requestApproval" -> HumanApprovalType.PERMISSIONS;
            case "item/tool/requestUserInput" -> HumanApprovalType.USER_INPUT;
            default -> throw new IllegalArgumentException("Unsupported approval request: " + method);
        };
    }

    private String requestId(JsonNode id) {
        return id.isTextual() ? id.asText() : id.toString();
    }

    private String requiredText(JsonNode node, String field) {
        String value = nullableText(node, field);
        if (value == null) throw new IllegalArgumentException("Missing required field: " + field);
        return value;
    }

    private String nullableText(JsonNode node, String field) {
        if (node == null || !node.hasNonNull(field)) return null;
        String value = node.get(field).asText();
        return value == null || value.isBlank() ? null : value;
    }

    private String toJson(JsonNode node) {
        try {
            return mapper.writeValueAsString(node);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to serialize Codex approval payload", error);
        }
    }

    private JsonNode readJson(String json) {
        try {
            return mapper.readTree(json);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to read stored Codex approval payload", error);
        }
    }
}
