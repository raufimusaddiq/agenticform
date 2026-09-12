package com.agenticform.message;

import com.agenticform.agent.AgentCapabilityPolicy;
import com.agenticform.agent.AgentCapabilityProfile;
import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.approval.HumanApprovalService;
import com.agenticform.runtime.RuntimeApprovalRequest;
import com.agenticform.runtime.RuntimeType;
import com.agenticform.codex.CodexJsonRpcClient;
import com.agenticform.operation.OperationRunEntity;
import com.agenticform.operation.OperationRunService;
import com.agenticform.operation.OperationalEnvironmentEntity;
import com.agenticform.operation.OperationalIncidentEntity;
import com.agenticform.operation.OperationalIncidentService;
import com.agenticform.operation.OperationalRegistryService;
import com.agenticform.operation.OperationalRunbookEntity;
import com.agenticform.operation.OperationalSignalEntity;
import com.agenticform.operation.OperationalSignalService;
import com.agenticform.policy.PolicyRuleEntity;
import com.agenticform.policy.PolicyRuleService;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
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
    private final AgentCapabilityPolicy capabilityPolicy;
    private final OperationalSignalService operationalSignals;
    private final OperationalIncidentService operationalIncidents;
    private final ObjectMapper mapper;

    public AgenticformDynamicToolHandler(CodexJsonRpcClient client, AgentRepository agentRepository,
                                         AgentMessageService messageService, HumanApprovalService approvalService,
                                         PolicyRuleService policyRuleService,
                                         OperationalRegistryService operationalRegistry,
                                         OperationRunService operationRunService,
                                         AgentCapabilityPolicy capabilityPolicy,
                                         OperationalSignalService operationalSignals,
                                         OperationalIncidentService operationalIncidents,
                                         ObjectMapper mapper) {
        this.client = client;
        this.agentRepository = agentRepository;
        this.messageService = messageService;
        this.approvalService = approvalService;
        this.policyRuleService = policyRuleService;
        this.operationalRegistry = operationalRegistry;
        this.operationRunService = operationRunService;
        this.capabilityPolicy = capabilityPolicy;
        this.operationalSignals = operationalSignals;
        this.operationalIncidents = operationalIncidents;
        this.mapper = mapper;
    }

    @PostConstruct
    void register() { client.addServerRequestHandler(this); }

    @Override
    public boolean supports(String method) { return METHOD.equals(method); }

    @Override
    public CompletionStage<JsonNode> handle(CodexJsonRpcClient.ServerRequest request) {
        JsonNode params = request.params();
        if (!NAMESPACE.equals(params.path("namespace").asText())) {
            throw new IllegalArgumentException("Unsupported dynamic tool namespace: " + params.path("namespace").asText());
        }
        String threadId = requiredText(params, "threadId");
        AgentEntity source = agentRepository.findByRuntimeTypeAndRuntimeSessionId(com.agenticform.runtime.RuntimeType.CODEX, threadId)
                .orElseThrow(() -> new NoSuchElementException("No Agenticform agent owns runtime session " + threadId));
        String tool = requiredText(params, "tool");
        JsonNode arguments = params.path("arguments");
        return switch (tool) {
            case "list_agents" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.READ);
                yield CompletableFuture.completedFuture(listAgents(source));
            }
            case "send_message" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.MESSAGE);
                yield CompletableFuture.completedFuture(sendMessage(source, arguments));
            }
            case "broadcast_message" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.MESSAGE);
                yield CompletableFuture.completedFuture(broadcastMessage(source, arguments));
            }
            case "handoff_to_operations" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.MESSAGE);
                yield CompletableFuture.completedFuture(handoffToOperations(source, arguments));
            }
            case "list_policy_rules" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.READ);
                yield CompletableFuture.completedFuture(listPolicyRules(source));
            }
            case "list_runbooks" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.READ);
                yield CompletableFuture.completedFuture(listRunbooks(source));
            }
            case "request_operation" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.DEPLOY);
                yield CompletableFuture.completedFuture(requestOperation(source, arguments));
            }
            case "get_operation_status" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.READ);
                yield CompletableFuture.completedFuture(getOperationStatus(source, arguments));
            }
            case "list_operational_signals" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.READ);
                yield CompletableFuture.completedFuture(listOperationalSignals(source, arguments));
            }
            case "list_incidents" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.READ);
                yield CompletableFuture.completedFuture(listIncidents(source, arguments));
            }
            case "get_incident" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.READ);
                yield CompletableFuture.completedFuture(getIncident(source, arguments));
            }
            case "update_incident" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.DEPLOY);
                yield CompletableFuture.completedFuture(updateIncident(source, arguments));
            }
            case "request_action" -> approvalService.receiveDeclaredAction(new RuntimeApprovalRequest(
                    request.id().isTextual() ? request.id().asText() : request.id().toString(), RuntimeType.CODEX,
                    threadId, request.method(), params), source, arguments);
            default -> throw new IllegalArgumentException("Unknown Agenticform dynamic tool: " + tool);
        };
    }

    private CompletionStage<JsonNode> completed(JsonNode value) {
        return CompletableFuture.completedFuture(value);
    }

    private JsonNode listAgents(AgentEntity source) {
        ArrayNode rows = mapper.createArrayNode();
        for (AgentEntity agent : agentRepository.findAllByProjectId(source.getProjectId())) {
            ObjectNode row = rows.addObject();
            row.put("id", agent.getId().toString());
            row.put("name", agent.getName());
            row.put("role", agent.getRole().name());
            row.put("capabilityProfile", agent.getCapabilityProfile().name());
            ArrayNode capabilities = row.putArray("capabilities");
            agent.getCapabilityProfile().capabilities().stream().map(Enum::name).sorted().forEach(capabilities::add);
            row.put("systemManaged", agent.isSystemManaged());
            row.put("responsibility", agent.getResponsibility());
            row.put("status", agent.getStatus().name());
            row.put("queueMode", agent.getQueueMode().name());
            row.put("humanControlMode", agent.getHumanControlMode().name());
            if (agent.getExecutionNodeId() != null) row.put("executionNodeId", agent.getExecutionNodeId().toString());
            row.put("self", agent.getId().equals(source.getId()));
        }
        ObjectNode payload = mapper.createObjectNode();
        payload.put("projectId", source.getProjectId().toString());
        payload.put("fanoutLimit", AgentMessageService.MAX_FANOUT);
        payload.set("agents", rows);
        return success(payload.toString());
    }

    private JsonNode listPolicyRules(AgentEntity source) {
        ArrayNode rows = mapper.createArrayNode();
        for (PolicyRuleEntity rule : policyRuleService.applicable(source.getProjectId(), source.getId(), source.getActiveTaskId())) {
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
        payload.put("precedence", "Capability profile may only tighten policy. Then TASK > AGENT > PROJECT > GLOBAL; exact action > wildcard; exact environment > wildcard.");
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
        payload.set("runbooks", rows);
        return success(payload.toString());
    }

    private JsonNode requestOperation(AgentEntity source, JsonNode arguments) {
        requireOperationalAgent(source);
        OperationalRunbookEntity runbook = operationalRegistry.runbook(source.getProjectId(), requiredText(arguments, "runbookKey"));
        OperationRunEntity run = operationRunService.start(runbook.getId(), new OperationRunService.StartRequest(
                source.getId(), source.getActiveTaskId(), "operational-agent:" + source.getId(),
                stringMap(arguments.path("parameters"))));
        return success(operationPayload(run).toString());
    }

    private JsonNode getOperationStatus(AgentEntity source, JsonNode arguments) {
        UUID runId = UUID.fromString(requiredText(arguments, "runId"));
        OperationRunService.RunDetail detail = operationRunService.detail(runId);
        if (!source.getProjectId().equals(detail.run().getProjectId())) throw new IllegalArgumentException("Operation belongs to another project");
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

    private JsonNode listOperationalSignals(AgentEntity source, JsonNode arguments) {
        OperationalSignalEntity.Status status = arguments.hasNonNull("status")
                ? OperationalSignalEntity.Status.valueOf(arguments.get("status").asText().toUpperCase()) : null;
        ArrayNode rows = mapper.createArrayNode();
        for (OperationalSignalEntity signal : operationalSignals.list(source.getProjectId(), status)) {
            ObjectNode row = rows.addObject();
            row.put("id", signal.getId().toString());
            row.put("source", signal.getSource().name());
            row.put("type", signal.getSignalType());
            row.put("severity", signal.getSeverity().name());
            row.put("status", signal.getStatus().name());
            row.put("occurrenceCount", signal.getOccurrenceCount());
            row.put("firstSeenAt", signal.getFirstSeenAt().toString());
            row.put("lastSeenAt", signal.getLastSeenAt().toString());
            if (signal.getCorrelationKey() != null) row.put("correlationKey", signal.getCorrelationKey());
            try { row.set("payload", mapper.readTree(signal.getPayloadJson())); }
            catch (Exception ignored) { row.put("payload", signal.getPayloadJson()); }
        }
        ObjectNode payload = mapper.createObjectNode();
        payload.set("signals", rows);
        return success(payload.toString());
    }

    private JsonNode listIncidents(AgentEntity source, JsonNode arguments) {
        OperationalIncidentEntity.Status status = arguments.hasNonNull("status")
                ? OperationalIncidentEntity.Status.valueOf(arguments.get("status").asText().toUpperCase()) : null;
        ArrayNode rows = mapper.createArrayNode();
        for (OperationalIncidentEntity incident : operationalIncidents.list(source.getProjectId(), status)) {
            rows.add(incidentPayload(incident));
        }
        ObjectNode payload = mapper.createObjectNode();
        payload.set("incidents", rows);
        return success(payload.toString());
    }

    private JsonNode getIncident(AgentEntity source, JsonNode arguments) {
        UUID incidentId = UUID.fromString(requiredText(arguments, "incidentId"));
        OperationalIncidentService.IncidentDetail detail = operationalIncidents.detail(incidentId);
        if (!source.getProjectId().equals(detail.incident().getProjectId())) throw new IllegalArgumentException("Incident belongs to another project");
        ObjectNode payload = incidentPayload(detail.incident());
        ArrayNode evidence = payload.putArray("signals");
        for (OperationalSignalEntity signal : detail.signals()) {
            ObjectNode row = evidence.addObject();
            row.put("id", signal.getId().toString());
            row.put("source", signal.getSource().name());
            row.put("type", signal.getSignalType());
            row.put("severity", signal.getSeverity().name());
            row.put("occurrenceCount", signal.getOccurrenceCount());
            row.put("lastSeenAt", signal.getLastSeenAt().toString());
            try { row.set("payload", mapper.readTree(signal.getPayloadJson())); }
            catch (Exception ignored) { row.put("payload", signal.getPayloadJson()); }
        }
        return success(payload.toString());
    }

    private JsonNode updateIncident(AgentEntity source, JsonNode arguments) {
        requireOperationalAgent(source);
        UUID incidentId = UUID.fromString(requiredText(arguments, "incidentId"));
        OperationalIncidentService.IncidentDetail detail = operationalIncidents.detail(incidentId);
        if (!source.getProjectId().equals(detail.incident().getProjectId())) throw new IllegalArgumentException("Incident belongs to another project");
        OperationalIncidentEntity.Status status = OperationalIncidentEntity.Status.valueOf(
                requiredText(arguments, "status").toUpperCase());
        if (status == OperationalIncidentEntity.Status.OPEN) throw new IllegalArgumentException("Operational Agent cannot reset incident to OPEN");
        OperationalIncidentEntity incident = operationalIncidents.transition(
                incidentId, status, arguments.path("summary").asText(null));
        return success(incidentPayload(incident).toString());
    }

    private ObjectNode incidentPayload(OperationalIncidentEntity incident) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("incidentId", incident.getId().toString());
        payload.put("type", incident.getIncidentType());
        payload.put("severity", incident.getSeverity().name());
        payload.put("status", incident.getStatus().name());
        payload.put("title", incident.getTitle());
        payload.put("summary", incident.getSummary());
        payload.put("firstSeenAt", incident.getFirstSeenAt().toString());
        payload.put("lastSeenAt", incident.getLastSeenAt().toString());
        payload.put("wakeStatus", incident.getWakeStatus().name());
        if (incident.getSuspectedChange() != null) payload.put("suspectedChange", incident.getSuspectedChange());
        if (incident.getResolutionSummary() != null) payload.put("resolutionSummary", incident.getResolutionSummary());
        return payload;
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
        if (source.getRole() == AgentRole.OPERATIONAL) throw new IllegalArgumentException("Operational Agent cannot hand off an operation to itself");
        AgentEntity target = agentRepository.findByProjectIdAndRole(source.getProjectId(), AgentRole.OPERATIONAL)
                .orElseThrow(() -> new IllegalStateException("No Operational Agent is provisioned for this project"));
        AgentMessageType type = arguments.hasNonNull("type")
                ? AgentMessageType.valueOf(arguments.get("type").asText().toUpperCase()) : AgentMessageType.HANDOFF;
        if (type != AgentMessageType.HANDOFF && type != AgentMessageType.REQUEST && type != AgentMessageType.BLOCKER) {
            throw new IllegalArgumentException("Operational handoff type must be HANDOFF, REQUEST, or BLOCKER");
        }
        AgentMessageEntity message = messageService.send(source.getId(), target.getId(), type,
                requiredText(arguments, "subject"), requiredText(arguments, "content"), null);
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
        UUID replyTo = arguments.hasNonNull("replyToMessageId") ? UUID.fromString(arguments.get("replyToMessageId").asText()) : null;
        AgentMessageEntity message = messageService.send(source.getId(), targetAgentId, messageType(arguments),
                requiredText(arguments, "subject"), requiredText(arguments, "content"), replyTo);
        return success(messagePayload(message, messageService.deliveries(message.getId())).toString());
    }

    private JsonNode broadcastMessage(AgentEntity source, JsonNode arguments) {
        AgentMessageAudienceType audienceType = AgentMessageAudienceType.valueOf(requiredText(arguments, "audienceType").toUpperCase());
        if (audienceType == AgentMessageAudienceType.DIRECT) throw new IllegalArgumentException("broadcast_message requires a fanout audience");
        List<UUID> agentIds = new ArrayList<>();
        JsonNode ids = arguments.path("agentIds");
        if (ids.isArray()) ids.forEach(id -> agentIds.add(UUID.fromString(id.asText())));
        AgentRole role = arguments.hasNonNull("role") ? AgentRole.valueOf(arguments.get("role").asText().toUpperCase()) : null;
        UUID groupId = arguments.hasNonNull("groupId") ? UUID.fromString(arguments.get("groupId").asText()) : null;
        AgentMessageService.SendResult result = messageService.sendAudience(
                source.getId(), new AgentMessageService.AudienceRequest(audienceType, agentIds, role, groupId),
                messageType(arguments), requiredText(arguments, "subject"), requiredText(arguments, "content"), null);
        return success(messagePayload(result.message(), result.deliveries()).toString());
    }

    private ObjectNode messagePayload(AgentMessageEntity message, List<AgentMessageDeliveryEntity> deliveries) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("messageId", message.getId().toString());
        payload.put("conversationId", message.getConversationId().toString());
        payload.put("audienceType", message.getAudienceType().name());
        payload.put("status", message.getStatus().name());
        payload.put("hopCount", message.getHopCount());
        ArrayNode rows = payload.putArray("deliveries");
        for (AgentMessageDeliveryEntity delivery : deliveries) {
            ObjectNode row = rows.addObject();
            row.put("agentId", delivery.getToAgentId().toString());
            row.put("status", delivery.getStatus().name());
            row.put("attemptCount", delivery.getAttemptCount());
            if (delivery.getLastError() != null) row.put("lastError", delivery.getLastError());
        }
        return payload;
    }

    private AgentMessageType messageType(JsonNode arguments) {
        return arguments.hasNonNull("type") ? AgentMessageType.valueOf(arguments.get("type").asText().toUpperCase()) : AgentMessageType.INFORMATION;
    }

    private void requireOperationalAgent(AgentEntity source) {
        if (source.getRole() != AgentRole.OPERATIONAL) {
            throw new IllegalArgumentException("Only the project's Operational Agent may perform this action");
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
        ObjectNode item = items.addObject();
        item.put("type", "inputText");
        item.put("text", text);
        return response;
    }

    private String requiredText(JsonNode node, String field) {
        String value = node.path(field).asText();
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Missing required field: " + field);
        return value;
    }
}
