package com.agenticform.message;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.approval.HumanApprovalService;
import com.agenticform.codex.CodexJsonRpcClient;
import com.agenticform.operation.OperationRunEntity;
import com.agenticform.operation.OperationRunService;
import com.agenticform.operation.OperationalEnvironmentEntity;
import com.agenticform.operation.OperationalRegistryService;
import com.agenticform.operation.OperationalRunbookEntity;
import com.agenticform.policy.PolicyRuleEntity;
import com.agenticform.policy.PolicyRuleService;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

@Component
public class AgenticformDynamicToolHandler implements CodexJsonRpcClient.ServerRequestHandler {
    private static final String METHOD = "item/tool/call";
    private static final String NAMESPACE = "agenticform";

    private final CodexJsonRpcClient client;
    private final AgentRepository agentRepository;
    private final AgentMessageService messageService;
    private final HumanApprovalService approvalService;
    private final PolicyRuleService policyRuleService;
    private final OperationalRegistryService operationalRegistry;
    private final OperationRunService operationRunService;
    private final ObjectMapper mapper;

    public AgenticformDynamicToolHandler(CodexJsonRpcClient client, AgentRepository agentRepository,
                                         AgentMessageService messageService, HumanApprovalService approvalService,
                                         PolicyRuleService policyRuleService,
                                         OperationalRegistryService operationalRegistry,
                                         OperationRunService operationRunService,
                                         ObjectMapper mapper) {
        this.client = client;
        this.agentRepository = agentRepository;
        this.messageService = messageService;
        this.approvalService = approvalService;
        this.policyRuleService = policyRuleService;
        this.operationalRegistry = operationalRegistry;
        this.operationRunService = operationRunService;
        this.mapper = mapper;
    }

    @PostConstruct
    void register() {
        client.addServerRequestHandler(this);
    }

    @Override
    public boolean supports(String method) {
        return METHOD.equals(method);
    }

    @Override
    public CompletionStage<JsonNode> handle(CodexJsonRpcClient.ServerRequest request) {
        JsonNode params = request.params();
        if (!NAMESPACE.equals(params.path("namespace").asText())) {
            throw new IllegalArgumentException("Unsupported dynamic tool namespace: " + params.path("namespace").asText());
        }

        String threadId = requiredText(params, "threadId");
        AgentEntity source = agentRepository.findByCodexThreadId(threadId)
                .orElseThrow(() -> new NoSuchElementException("No Agenticform agent owns Codex thread " + threadId));

        String tool = requiredText(params, "tool");
        JsonNode arguments = params.path("arguments");
        return switch (tool) {
            case "list_agents" -> CompletableFuture.completedFuture(listAgents(source));
            case "send_message" -> CompletableFuture.completedFuture(sendMessage(source, arguments));
            case "handoff_to_operations" -> CompletableFuture.completedFuture(handoffToOperations(source, arguments));
            case "list_policy_rules" -> CompletableFuture.completedFuture(listPolicyRules(source));
            case "list_runbooks" -> CompletableFuture.completedFuture(listRunbooks(source));
            case "request_operation" -> CompletableFuture.completedFuture(requestOperation(source, arguments));
            case "get_operation_status" -> CompletableFuture.completedFuture(getOperationStatus(source, arguments));
            case "request_action" -> approvalService.receiveDeclaredAction(request, source, arguments);
            case "request_protected_action" -> approvalService.receiveProtectedAction(request, source, arguments);
            default -> throw new IllegalArgumentException("Unknown Agenticform dynamic tool: " + tool);
        };
    }

    private JsonNode listAgents(AgentEntity source) {
        List<AgentEntity> agents = agentRepository.findAllByProjectId(source.getProjectId());
        ArrayNode rows = mapper.createArrayNode();
        for (AgentEntity agent : agents) {
            ObjectNode row = mapper.createObjectNode();
            row.put("id", agent.getId().toString());
            row.put("name", agent.getName());
            row.put("role", agent.getRole().name());
            row.put("systemManaged", agent.isSystemManaged());
            row.put("responsibility", agent.getResponsibility());
            row.put("status", agent.getStatus().name());
            row.put("queueMode", agent.getQueueMode().name());
            row.put("humanControlMode", agent.getHumanControlMode().name());
            row.put("self", agent.getId().equals(source.getId()));
            rows.add(row);
        }

        ObjectNode payload = mapper.createObjectNode();
        payload.put("projectId", source.getProjectId().toString());
        payload.set("agents", rows);
        return success(payload.toString());
    }

    private JsonNode listPolicyRules(AgentEntity source) {
        ArrayNode rows = mapper.createArrayNode();
        for (PolicyRuleEntity rule : policyRuleService.applicable(
                source.getProjectId(), source.getId(), source.getActiveTaskId())) {
            ObjectNode row = rows.addObject();
            row.put("id", rule.getId().toString());
            row.put("scopeType", rule.getScopeType().name());
            if (rule.getScopeId() != null) row.put("scopeId", rule.getScopeId().toString());
            row.put("action", rule.getAction());
            row.put("environment", rule.getEnvironment());
            row.put("effect", rule.getEffect().name());
            row.put("description", rule.getDescription());
        }
        ObjectNode payload = mapper.createObjectNode();
        payload.put("precedence", "TASK > AGENT > PROJECT > GLOBAL; exact action > wildcard; exact environment > wildcard");
        payload.set("rules", rows);
        return success(payload.toString());
    }

    private JsonNode listRunbooks(AgentEntity source) {
        ArrayNode rows = mapper.createArrayNode();
        for (OperationalRunbookEntity runbook : operationalRegistry.runbooks(source.getProjectId())) {
            if (!runbook.isEnabled()) continue;
            OperationalEnvironmentEntity environment = operationalRegistry.environment(runbook.getEnvironmentId());
            if (!environment.isEnabled()) continue;
            ObjectNode row = rows.addObject();
            row.put("id", runbook.getId().toString());
            row.put("key", runbook.getKey());
            row.put("name", runbook.getName());
            row.put("version", runbook.getVersion());
            row.put("action", runbook.getAction());
            row.put("environment", environment.getKey());
            row.put("environmentKind", environment.getKind().name());
            row.put("description", runbook.getDescription());
        }
        ObjectNode payload = mapper.createObjectNode();
        payload.put("projectId", source.getProjectId().toString());
        payload.put("requestAuthority", source.getRole() == AgentRole.OPERATIONAL ? "OPERATIONAL_AGENT" : "HANDOFF_REQUIRED");
        payload.put("note", source.getRole() == AgentRole.OPERATIONAL
                ? "Choose the runbook matching the intended operation. Agenticform evaluates policy and executes the immutable runbook snapshot."
                : "Operational execution is owned by the project's Operational Agent. Use handoff_to_operations rather than request_operation.");
        payload.set("runbooks", rows);
        return success(payload.toString());
    }

    private JsonNode requestOperation(AgentEntity source, JsonNode arguments) {
        requireOperationalAgent(source);
        String runbookKey = requiredText(arguments, "runbookKey");
        OperationalRunbookEntity runbook = operationalRegistry.runbook(source.getProjectId(), runbookKey);
        Map<String, String> parameters = stringMap(arguments.path("parameters"));
        OperationRunEntity run = operationRunService.start(runbook.getId(), new OperationRunService.StartRequest(
                source.getId(), source.getActiveTaskId(), "operational-agent:" + source.getId(), parameters));
        return success(operationPayload(run).toString());
    }

    private JsonNode getOperationStatus(AgentEntity source, JsonNode arguments) {
        UUID runId = UUID.fromString(requiredText(arguments, "runId"));
        OperationRunService.RunDetail detail = operationRunService.detail(runId);
        if (!source.getProjectId().equals(detail.run().getProjectId())) {
            throw new IllegalArgumentException("Operation belongs to another project");
        }
        ObjectNode payload = operationPayload(detail.run());
        ArrayNode steps = payload.putArray("steps");
        detail.steps().forEach(step -> {
            ObjectNode row = steps.addObject();
            row.put("key", step.getStepKey());
            row.put("name", step.getStepName());
            row.put("type", step.getStepType());
            row.put("status", step.getStatus().name());
            if (step.getSummary() != null) row.put("summary", step.getSummary());
            if (step.getExitCode() != null) row.put("exitCode", step.getExitCode());
            if (step.getDurationMs() != null) row.put("durationMs", step.getDurationMs());
        });
        return success(payload.toString());
    }

    private ObjectNode operationPayload(OperationRunEntity run) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("runId", run.getId().toString());
        payload.put("runbookId", run.getRunbookId().toString());
        payload.put("action", run.getAction());
        payload.put("environment", run.getEnvironmentKey());
        payload.put("status", run.getStatus().name());
        payload.put("policyEffect", run.getPolicyEffect().name());
        if (run.getPolicyRuleId() != null) payload.put("policyRuleId", run.getPolicyRuleId().toString());
        if (run.getLastError() != null) payload.put("lastError", run.getLastError());
        return payload;
    }

    private JsonNode handoffToOperations(AgentEntity source, JsonNode arguments) {
        if (source.getRole() == AgentRole.OPERATIONAL) {
            throw new IllegalArgumentException("Operational Agent cannot hand off an operation to itself");
        }
        AgentEntity target = agentRepository.findByProjectIdAndRole(source.getProjectId(), AgentRole.OPERATIONAL)
                .orElseThrow(() -> new IllegalStateException("No Operational Agent is provisioned for this project"));
        String subject = requiredText(arguments, "subject");
        String content = requiredText(arguments, "content");
        AgentMessageType type = arguments.hasNonNull("type")
                ? AgentMessageType.valueOf(arguments.get("type").asText().toUpperCase())
                : AgentMessageType.HANDOFF;
        if (type != AgentMessageType.HANDOFF && type != AgentMessageType.REQUEST && type != AgentMessageType.BLOCKER) {
            throw new IllegalArgumentException("Operational handoff type must be HANDOFF, REQUEST, or BLOCKER");
        }
        AgentMessageEntity message = messageService.send(source.getId(), target.getId(), type, subject, content, null);
        ObjectNode payload = mapper.createObjectNode();
        payload.put("operationalAgentId", target.getId().toString());
        payload.put("operationalAgentName", target.getName());
        payload.put("messageId", message.getId().toString());
        payload.put("conversationId", message.getConversationId().toString());
        payload.put("status", message.getStatus().name());
        return success(payload.toString());
    }

    private JsonNode sendMessage(AgentEntity source, JsonNode arguments) {
        UUID targetAgentId = UUID.fromString(requiredText(arguments, "targetAgentId"));
        AgentMessageType type = arguments.hasNonNull("type")
                ? AgentMessageType.valueOf(arguments.get("type").asText().toUpperCase())
                : AgentMessageType.INFORMATION;
        String subject = requiredText(arguments, "subject");
        String content = requiredText(arguments, "content");
        UUID replyTo = arguments.hasNonNull("replyToMessageId")
                ? UUID.fromString(arguments.get("replyToMessageId").asText())
                : null;

        AgentMessageEntity message = messageService.send(
                source.getId(), targetAgentId, type, subject, content, replyTo);

        ObjectNode payload = mapper.createObjectNode();
        payload.put("messageId", message.getId().toString());
        payload.put("conversationId", message.getConversationId().toString());
        payload.put("status", message.getStatus().name());
        payload.put("hopCount", message.getHopCount());
        if (message.getCodexQueuedSubmissionId() != null) {
            payload.put("queuedSubmissionId", message.getCodexQueuedSubmissionId());
        }
        if (message.getCodexTurnId() != null) {
            payload.put("turnId", message.getCodexTurnId());
        }
        return success(payload.toString());
    }

    private void requireOperationalAgent(AgentEntity source) {
        if (source.getRole() != AgentRole.OPERATIONAL) {
            throw new IllegalArgumentException("Only the project's Operational Agent may request registered operations; use handoff_to_operations");
        }
    }

    private Map<String, String> stringMap(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) return Map.of();
        if (!node.isObject()) throw new IllegalArgumentException("parameters must be an object");
        LinkedHashMap<String, String> result = new LinkedHashMap<>();
        node.properties().forEach(entry -> {
            if (!entry.getValue().isTextual()) throw new IllegalArgumentException("operation parameter values must be strings");
            result.put(entry.getKey(), entry.getValue().asText());
        });
        return Map.copyOf(result);
    }

    private JsonNode success(String text) {
        ObjectNode response = mapper.createObjectNode();
        response.put("success", true);
        ArrayNode items = response.putArray("contentItems");
        ObjectNode item = mapper.createObjectNode();
        item.put("type", "inputText");
        item.put("text", text);
        items.add(item);
        return response;
    }

    private String requiredText(JsonNode node, String field) {
        String value = node.path(field).asText();
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Missing required field: " + field);
        }
        return value;
    }
}
