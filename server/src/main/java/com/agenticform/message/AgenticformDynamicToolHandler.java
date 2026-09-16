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
import com.agenticform.operation.RepositoryRunbookDiscovery;
import com.agenticform.policy.PolicyRuleEntity;
import com.agenticform.policy.PolicyRuleService;
import com.agenticform.task.TaskDispatchService;
import com.agenticform.task.TaskDependencyService;
import com.agenticform.task.TaskDependencyType;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskDeliverable;
import com.agenticform.task.TaskKind;
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
    private final TaskDispatchService taskService;
    private final RepositoryRunbookDiscovery repositoryRunbookDiscovery;
    private final ObjectMapper mapper;

    public AgenticformDynamicToolHandler(CodexJsonRpcClient client, AgentRepository agentRepository,
                                         AgentMessageService messageService, HumanApprovalService approvalService,
                                         PolicyRuleService policyRuleService,
                                         OperationalRegistryService operationalRegistry,
                                         OperationRunService operationRunService,
                                         AgentCapabilityPolicy capabilityPolicy,
                                         OperationalSignalService operationalSignals,
                                         OperationalIncidentService operationalIncidents,
                                         TaskDispatchService taskService,
                                         RepositoryRunbookDiscovery repositoryRunbookDiscovery,
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
        this.taskService = taskService;
        this.repositoryRunbookDiscovery = repositoryRunbookDiscovery;
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
        String nodeId = params.path("_agenticformNodeId").asText(null);
        if (nodeId != null && !nodeId.isBlank()) {
            long generation = params.path("_agenticformRuntimeGeneration").asLong(0);
            if (generation <= 0 || source.getExecutionNodeId() == null
                    || !source.ownsRuntime(UUID.fromString(nodeId), generation, RuntimeType.CODEX, threadId)) {
                return CompletableFuture.completedFuture(failure("STALE_RUNTIME", "Runtime generation is no longer assigned to this agent"));
            }
        } else if (source.getExecutionNodeId() != null) {
            return CompletableFuture.completedFuture(failure("UNFENCED_RUNTIME", "Remote runtime request has no Agenticform runtime fence"));
        }
        String tool = requiredText(params, "tool");
        JsonNode arguments = params.path("arguments");
        return switch (tool) {
            case "list_agents" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.READ);
                yield CompletableFuture.completedFuture(listAgents(source));
            }
            case "list_messages" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.MESSAGE);
                yield CompletableFuture.completedFuture(listMessages(source, arguments));
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
            case "sync_repository_runbook" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.DEPLOY);
                yield CompletableFuture.completedFuture(syncRepositoryRunbook(source, arguments));
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
            case "create_task" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.ORCHESTRATE);
                yield CompletableFuture.completedFuture(createTask(source, arguments));
            }
            case "report_task", "block_task" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.MESSAGE);
                yield CompletableFuture.completedFuture(reportTask(source, arguments, tool.equals("block_task")));
            }
            case "request_human_clarification" -> {
                capabilityPolicy.require(source, AgentCapabilityProfile.Capability.MESSAGE);
                yield approvalService.receiveClarification(new RuntimeApprovalRequest(
                        request.id().isTextual() ? request.id().asText() : request.id().toString(), RuntimeType.CODEX,
                        threadId, request.method(), arguments), source, arguments);
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
            if (agent.getSpecialty() != null) row.put("specialty", agent.getSpecialty());
            ArrayNode capabilities = row.putArray("capabilities");
            agent.getCapabilityProfile().capabilities().stream().map(Enum::name).sorted().forEach(capabilities::add);
            row.put("systemManaged", agent.isSystemManaged());
            row.put("responsibility", agent.getResponsibility());
            row.put("status", agent.getStatus().name());
            row.put("queueMode", agent.getQueueMode().name());
            row.put("humanControlMode", agent.getHumanControlMode().name());
            row.put("runtimeGeneration", agent.getRuntimeGeneration());
            if (agent.getActiveTaskId() != null) row.put("activeTaskId", agent.getActiveTaskId().toString());
            if (agent.getExecutionNodeId() != null) row.put("executionNodeId", agent.getExecutionNodeId().toString());
            row.put("self", agent.getId().equals(source.getId()));
        }
        ObjectNode payload = mapper.createObjectNode();
        payload.put("projectId", source.getProjectId().toString());
        payload.put("fanoutLimit", AgentMessageService.MAX_FANOUT);
        payload.set("agents", rows);
        return success(payload.toString());
    }

    private JsonNode listMessages(AgentEntity source, JsonNode arguments) {
        boolean pendingOnly = arguments.path("pendingOnly").asBoolean(true);
        ArrayNode rows = mapper.createArrayNode();
        messageService.inbox(source.getId(), pendingOnly).forEach(item -> {
            ObjectNode row = rows.addObject();
            row.put("messageId", item.messageId().toString());
            row.put("fromAgentId", item.fromAgentId().toString());
            row.put("subject", item.subject());
            row.put("content", item.content());
            row.put("type", item.type().name());
            row.put("deliveryStatus", item.status().name());
            row.put("createdAt", item.createdAt().toString());
        });
        ObjectNode payload = mapper.createObjectNode();
        payload.put("pendingOnly", pendingOnly);
        payload.set("messages", rows);
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
        payload.set("repositoryPlan", repositoryPlan(source));
        return success(payload.toString());
    }

    /**
     * The Operational Agent must prefer the deployment process the project itself
     * declares. This resolves the repository manifest so "list_runbooks" reports
     * where the runbook came from, and whether the project currently has none
     * (meaning deployments are human-gated until the repository declares one).
     * Discovery failures degrade to an explanatory status instead of hiding the
     * registered runbooks from the agent.
     */
    private ObjectNode repositoryPlan(AgentEntity source) {
        ObjectNode node = mapper.createObjectNode();
        try {
            RepositoryRunbookDiscovery.Plan plan = repositoryRunbookDiscovery.plan(source.getProjectId(), null);
            node.put("source", plan.source().name());
            node.put("manifestPath", plan.manifestPath());
            if (plan.repository() != null) node.put("repository", plan.repository());
            if (plan.commitSha() != null) node.put("commitSha", plan.commitSha());
            if (plan.runbookKey() != null) node.put("runbookKey", plan.runbookKey());
            if (plan.action() != null) node.put("action", plan.action());
            if (plan.fallbackReason() != null) node.put("reason", plan.fallbackReason());
            node.put("approval", plan.approvalExpectation());
            node.put("nextAction", plan.source() == RepositoryRunbookDiscovery.Source.REPOSITORY_MANIFEST
                    ? "Sync with sync_repository_runbook, then request_operation with that runbook key."
                    : "No repository runbook. Deployments are human-gated: call request_action with action PRODUCTION_DEPLOY so a human performs the deployment and records evidence.");
        } catch (RuntimeException error) {
            node.put("source", "UNAVAILABLE");
            node.put("reason", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
        }
        return node;
    }

    private JsonNode requestOperation(AgentEntity source, JsonNode arguments) {
        requireOperationalAgent(source);
        OperationalRunbookEntity runbook = operationalRegistry.runbook(source.getProjectId(), requiredText(arguments, "runbookKey"));
        UUID requestedTaskId = arguments.hasNonNull("taskId")
                ? UUID.fromString(arguments.get("taskId").asText())
                : source.getActiveTaskId();
        UUID deliverableRoot = taskService.resolveDeliverableRoot(source.getProjectId(), requestedTaskId);
        OperationRunEntity run = operationRunService.start(runbook.getId(), new OperationRunService.StartRequest(
                source.getId(), deliverableRoot, "operational-agent:" + source.getId(),
                stringMap(arguments.path("parameters"))));
        return success(operationPayload(run).toString());
    }

    /**
     * Registers the deployment runbook the project repository declares. This is
     * registration only: nothing is dispatched, and production policy still gates
     * the resulting run at request_operation time.
     */
    private JsonNode syncRepositoryRunbook(AgentEntity source, JsonNode arguments) {
        requireOperationalAgent(source);
        String environmentKey = arguments.hasNonNull("environmentKey")
                ? arguments.get("environmentKey").asText() : null;
        RepositoryRunbookDiscovery.Plan plan = repositoryRunbookDiscovery.sync(source.getProjectId(), environmentKey);
        ObjectNode payload = mapper.createObjectNode();
        payload.put("source", plan.source().name());
        payload.put("manifestPath", plan.manifestPath());
        payload.put("registered", plan.registered());
        payload.put("action", plan.action());
        payload.put("approval", plan.approvalExpectation());
        if (plan.repository() != null) payload.put("repository", plan.repository());
        if (plan.commitSha() != null) payload.put("commitSha", plan.commitSha());
        if (plan.runbookKey() != null) payload.put("runbookKey", plan.runbookKey());
        if (plan.fallbackReason() != null) payload.put("reason", plan.fallbackReason());
        payload.put("stepCount", plan.steps().size());
        payload.put("nextAction", plan.registered()
                ? "Call request_operation with this runbookKey."
                : "No repository runbook. Deployments are human-gated: call request_action with action PRODUCTION_DEPLOY so a human performs the deployment and records evidence.");
        return success(payload.toString());
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
        AgentMessageType type = messageType(arguments);
        String subject = requiredText(arguments, "subject");
        String content = requiredText(arguments, "content");
        if (source.getRole() == AgentRole.ORCHESTRATOR && replyTo == null
                && type != AgentMessageType.RESULT && type != AgentMessageType.REVIEW_RESULT
                && type != AgentMessageType.BLOCKER && messageService.hasPendingInbox(source.getId())) {
            throw new IllegalStateException("Pending inbound agent message exists; inspect agenticform.list_messages and process it before sending a follow-up");
        }
        AgentMessageEntity message = messageService.send(source.getId(), targetAgentId, type, subject, content, replyTo);
        return success(messagePayload(message, messageService.deliveries(message.getId())).toString());
    }

    private JsonNode createTask(AgentEntity source, JsonNode arguments) {
        UUID targetAgentId = UUID.fromString(requiredText(arguments, "agentId"));
        AgentEntity target = agentRepository.findById(targetAgentId)
                .orElseThrow(() -> new NoSuchElementException("Target agent not found: " + targetAgentId));
        if (!source.getProjectId().equals(target.getProjectId())) throw new IllegalArgumentException("Delegated task must stay within one project");
        if (target.getRole() == AgentRole.OPERATIONAL) {
            ObjectNode response = (ObjectNode) failure("OPERATIONS_HANDOFF_REQUIRED", "Operational work uses the dedicated handoff, not a normal task");
            response.put("operationalAgentId", targetAgentId.toString());
            response.put("nextAction", "Call handoff_to_operations with the requested operation and acceptance criteria");
            return response;
        }
        UUID dependsOn = arguments.hasNonNull("dependsOnTaskId") ? UUID.fromString(arguments.get("dependsOnTaskId").asText()) : null;
        TaskEntity task = taskService.create(targetAgentId, requiredText(arguments, "title"), requiredText(arguments, "prompt"),
                arguments.path("priority").asInt(0), dependsOn == null ? List.of() : List.of(new TaskDependencyService.DependencyRequest(dependsOn, TaskDependencyType.REQUIRES_SUCCESS)), source.getActiveTaskId(),
                arguments.hasNonNull("kind") ? TaskKind.valueOf(arguments.get("kind").asText().toUpperCase()) : null,
                new TaskDispatchService.DeliveryRequest(
                        arguments.hasNonNull("deliverable") ? TaskDeliverable.valueOf(arguments.get("deliverable").asText().toUpperCase()) : null,
                        boolArgument(arguments, "reviewRequired"), boolArgument(arguments, "architectureRequired"),
                        boolArgument(arguments, "deploymentRequired"), textArgument(arguments, "environmentKey")));
        ObjectNode payload = mapper.createObjectNode();
        payload.put("taskId", task.getId().toString());
        payload.put("assignedAgentId", targetAgentId.toString());
        payload.put("status", task.getStatus().name());
        payload.put("kind", task.getKind().name());
        payload.put("workflowId", task.getWorkflowId().toString());
        payload.put("deliverable", task.getDeliverable().name());
        payload.put("deliveryStage", task.getDeliveryStage().name());
        return success(payload.toString());
    }

    private Boolean boolArgument(JsonNode arguments, String field) {
        return arguments.hasNonNull(field) ? arguments.get(field).asBoolean() : null;
    }

    private String textArgument(JsonNode arguments, String field) {
        return arguments.hasNonNull(field) ? arguments.get(field).asText() : null;
    }

    private JsonNode reportTask(AgentEntity source, JsonNode arguments, boolean blocked) {
        UUID taskId;
        JsonNode generation = arguments.path("runtimeGeneration");
        try {
            taskId = UUID.fromString(requiredText(arguments, "taskId"));
            if (!generation.isIntegralNumber() || !generation.canConvertToLong() || generation.asLong() < 0) {
                throw new IllegalArgumentException("runtimeGeneration must be a nonnegative integer");
            }
        } catch (IllegalArgumentException error) {
            ObjectNode response = (ObjectNode) failure("REPORT_IDENTITY_REQUIRED", "Pass the taskId and runtimeGeneration from the original dispatch; never infer them from a newer task");
            response.put("nextAction", "Inspect the original dispatch identity; list_agents shows current ownership for reconciliation only");
            return response;
        }
        TaskEntity task;
        try {
            task = blocked
                    ? taskService.block(source.getId(), taskId, generation.asLong(), requiredText(arguments, "reason"))
                    : taskService.report(source.getId(), taskId, generation.asLong(), requiredText(arguments, "report"),
                            parseEvidence(arguments.path("evidence")));
        } catch (TaskDispatchService.ReportRejectedException error) {
            ObjectNode response = (ObjectNode) failure(error.code, error.getMessage()
                    + "; taskId=" + error.taskId + "; activeTaskId=" + error.activeTaskId);
            response.put("taskId", error.taskId.toString());
            if (error.activeTaskId != null) response.put("activeTaskId", error.activeTaskId.toString());
            response.put("nextAction", error.getMessage());
            return response;
        } catch (NoSuchElementException | IllegalArgumentException error) {
            ObjectNode response = (ObjectNode) failure(error instanceof NoSuchElementException ? "TASK_NOT_FOUND" : "INVALID_TASK_REPORT", error.getMessage());
            response.put("taskId", taskId.toString());
            response.put("nextAction", "Inspect the original task identity and report; do not create a replacement task");
            return response;
        }
        ObjectNode payload = mapper.createObjectNode();
        payload.put("taskId", task.getId().toString());
        payload.put("reported", true);
        payload.put("blocked", blocked);
        payload.put("deliverable", task.getDeliverable().name());
        payload.put("deliveryStage", task.getDeliveryStage().name());
        return success(payload.toString());
    }

    private com.agenticform.task.TaskEvidence parseEvidence(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) return null;
        if (!node.isObject()) throw new IllegalArgumentException("evidence must be an object");
        String outcome = com.agenticform.task.TaskEvidence.normalizeOutcome(node.path("outcome").asText(null));
        if (outcome == null) throw new IllegalArgumentException("evidence.outcome is required");
        List<com.agenticform.task.TaskEvidence.Artifact> artifacts = new ArrayList<>();
        for (JsonNode entry : node.path("artifacts")) {
            if (!entry.isObject()) throw new IllegalArgumentException("evidence.artifacts entries must be objects");
            String type = requiredText(entry, "type");
            String reference = requiredText(entry, "reference");
            artifacts.add(new com.agenticform.task.TaskEvidence.Artifact(
                    com.agenticform.task.TaskEvidence.ArtifactType.valueOf(type.toUpperCase()),
                    reference, entry.path("revision").asText(null), entry.path("digest").asText(null)));
        }
        List<com.agenticform.task.TaskEvidence.Validation> validations = new ArrayList<>();
        for (JsonNode entry : node.path("validations")) {
            if (!entry.isObject()) throw new IllegalArgumentException("evidence.validations entries must be objects");
            String status = com.agenticform.task.TaskEvidence.normalizeValidationStatus(requiredText(entry, "status"));
            if (!java.util.Set.of("PASSED", "FAILED", "NOT_RUN").contains(status)) {
                throw new IllegalArgumentException("evidence validation status must be PASSED, FAILED, or NOT_RUN");
            }
            validations.add(new com.agenticform.task.TaskEvidence.Validation(
                    requiredText(entry, "name"), status, entry.path("reference").asText(null)));
        }
        return new com.agenticform.task.TaskEvidence(outcome, artifacts, validations,
                textEntries(node.path("blockers")), textEntries(node.path("followUp")));
    }

    private List<String> textEntries(JsonNode node) {
        List<String> values = new ArrayList<>();
        for (JsonNode entry : node) {
            if (!entry.isTextual()) throw new IllegalArgumentException("evidence text lists must contain strings");
            String value = entry.asText();
            if (value != null && !value.isBlank()) values.add(value.trim());
        }
        return List.copyOf(values);
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

    private JsonNode failure(String code, String text) {
        ObjectNode response = mapper.createObjectNode();
        response.put("success", false);
        response.put("code", code);
        ArrayNode items = response.putArray("contentItems");
        ObjectNode item = items.addObject();
        item.put("type", "inputText");
        item.put("text", code + ": " + text);
        return response;
    }

    private String requiredText(JsonNode node, String field) {
        String value = node.path(field).asText();
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Missing required field: " + field);
        return value;
    }
}
