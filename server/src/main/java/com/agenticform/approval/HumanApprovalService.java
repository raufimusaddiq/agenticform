package com.agenticform.approval;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.codex.CodexJsonRpcClient;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
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
    private final ObjectMapper mapper;
    private final Map<UUID, CompletableFuture<JsonNode>> pendingResponses = new ConcurrentHashMap<>();

    public HumanApprovalService(HumanApprovalRepository repository, AgentRepository agentRepository,
                                HumanApprovalPolicy policy, ObjectMapper mapper) {
        this.repository = repository;
        this.agentRepository = agentRepository;
        this.policy = policy;
        this.mapper = mapper;
    }

    @PostConstruct
    void recoverOrphanedRequests() {
        for (HumanApprovalEntity approval : repository.findAllByStatus(HumanApprovalStatus.PENDING)) {
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
        if (projectId != null) {
            return repository.findAllByProjectIdOrderByCreatedAtDesc(projectId);
        }
        if (status != null) {
            return repository.findAllByStatusOrderByCreatedAtDesc(status);
        }
        return repository.findAllByOrderByCreatedAtDesc();
    }

    public CompletionStage<JsonNode> receive(CodexJsonRpcClient.ServerRequest request) {
        JsonNode params = request.params();
        String threadId = requiredText(params, "threadId");
        AgentEntity agent = agentRepository.findByCodexThreadId(threadId)
                .orElseThrow(() -> new NoSuchElementException("No Agenticform agent owns Codex thread " + threadId));

        HumanApprovalType type = typeForMethod(request.method());
        HumanApprovalPolicy.Evaluation evaluation = policy.evaluate(agent, type, params);
        HumanApprovalStatus initialStatus = evaluation.autoApprove()
                ? HumanApprovalStatus.AUTO_APPROVED : HumanApprovalStatus.PENDING;

        HumanApprovalEntity approval = new HumanApprovalEntity(
                agent.getProjectId(),
                agent.getId(),
                requestId(request.id()),
                request.method(),
                type,
                agent.getHumanControlMode(),
                evaluation.risk(),
                initialStatus,
                threadId,
                nullableText(params, "turnId"),
                nullableText(params, "itemId"),
                evaluation.summary(),
                toJson(params)
        );

        if (evaluation.autoApprove()) {
            JsonNode response = automaticResponse(type);
            approval.resolve(HumanApprovalStatus.AUTO_APPROVED, toJson(response));
            repository.save(approval);
            return CompletableFuture.completedFuture(response);
        }

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

        JsonNode response = decisionResponse(approval, decision);
        HumanApprovalStatus status = switch (decision) {
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
        if (!pendingResponses.containsKey(approvalId)) {
            approval.orphan();
            repository.save(approval);
            throw new IllegalStateException("Codex request is no longer attached; wait for the request to be replayed");
        }
        return approval;
    }

    private void resolvePending(HumanApprovalEntity approval, HumanApprovalStatus status, JsonNode response) {
        CompletableFuture<JsonNode> future = pendingResponses.remove(approval.getId());
        if (future == null) {
            approval.orphan();
            repository.save(approval);
            throw new IllegalStateException("Codex request is no longer attached");
        }

        approval.resolve(status, toJson(response));
        repository.save(approval);
        restoreAgentStatus(approval.getAgentId());
        future.complete(response);
    }

    private void restoreAgentStatus(UUID agentId) {
        if (repository.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)) {
            return;
        }
        agentRepository.findById(agentId).ifPresent(agent -> {
            agent.setStatus(agent.getActiveTurnId() == null ? AgentStatus.IDLE : AgentStatus.WORKING);
            agentRepository.save(agent);
        });
    }

    private JsonNode automaticResponse(HumanApprovalType type) {
        ObjectNode response = mapper.createObjectNode();
        if (type == HumanApprovalType.COMMAND_EXECUTION || type == HumanApprovalType.FILE_CHANGE) {
            response.put("decision", "accept");
            return response;
        }
        throw new IllegalStateException("No automatic response is defined for " + type);
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

        throw new IllegalStateException("Unsupported approval type: " + approval.getType());
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
