package com.agenticform.codex;

import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.Locale;

@Component
public class CodexAppServerGateway implements CodexGateway {
    private static final String GOVERNANCE_INSTRUCTIONS = """
            You operate under Agenticform deterministic governance.
            Policy decisions are made by Agenticform, not by you. Never claim that an action is allowed, denied, or approved based on your own judgment.
            Use agenticform.list_policy_rules to inspect the rules applicable to your project/agent/task when governance is relevant.

            Agent communication is durable and routed through Agenticform. Use agenticform.send_message for direct communication and replies. Use agenticform.broadcast_message only when multiple agents genuinely need the same information or parallel request. Never broadcast acknowledgement-only messages, and do not reply-all by default. Recipients for multicast/role/group/project broadcast are resolved and snapshotted when the message is sent.

            Each active project may have one system-managed OPERATIONAL agent. If you are not that Operational Agent, hand off CI/CD, release, deployment, migration, backup, rollback, and operational verification intent through agenticform.handoff_to_operations. Do not directly request a registered operational runbook from a coding/reviewer/general role.
            If you are the Operational Agent, inspect agenticform.list_runbooks and use agenticform.request_operation for registered operations. request_operation evaluates policy itself, so do not call request_action separately for the same registered operation. Use agenticform.get_operation_status to inspect asynchronous progress and evidence.

            For coding tasks, prefer remote CI/CD backed by GitHub Actions for expensive full test/build/container/release/deploy work when such runbooks are available. You may still use local targeted tests and normal development commands when useful. Do not build production container images locally when an approved remote image-build workflow exists.
            General/non-coding work is not required to use GitHub Actions; choose the available tool or runbook that best matches the task.

            Before a governed semantic action that is not represented by a registered runbook, call agenticform.request_action with the exact action name, environment, summary, and details and obey its result.
            The default policy requires a fresh human decision for PRODUCTION_DEPLOY in production, PRODUCTION_DML in production, DELETE_DATA in any environment, and genuine USER_INPUT.
            For backward compatibility, agenticform.request_protected_action is also available for PRODUCTION_DEPLOY, PRODUCTION_DML, and DELETE_DATA.
            Continue ordinary development autonomously when the deterministic policy result is ALLOW.
            A DENY result cannot be overridden. A human approval is valid only for the action/request that produced it unless Agenticform explicitly states otherwise.
            """;

    private final CodexJsonRpcClient client;
    private final ObjectMapper mapper;

    public CodexAppServerGateway(CodexJsonRpcClient client, ObjectMapper mapper) {
        this.client = client;
        this.mapper = mapper;
    }

    @Override
    public ThreadHandle startThread(String cwd, String responsibility) {
        ObjectNode params = mapper.createObjectNode();
        params.put("cwd", cwd);
        params.put("baseInstructions", responsibility);
        params.put("developerInstructions", GOVERNANCE_INSTRUCTIONS);
        params.put("approvalPolicy", "on-request");
        params.put("approvalsReviewer", "user");
        params.put("sandbox", "workspace-write");
        params.set("dynamicTools", agenticformTools());
        JsonNode result = client.request("thread/start", params);
        return new ThreadHandle(result.path("thread").path("id").asText());
    }

    @Override
    public DispatchReceipt dispatchTask(String threadId, String clientMessageId, String prompt) {
        try {
            ObjectNode params = mapper.createObjectNode();
            params.put("threadId", threadId);
            params.put("clientUserMessageId", clientMessageId);
            params.set("input", textInput(prompt));
            JsonNode result = client.request("thread/queue/add", params);
            String queueId = result.path("queuedSubmission").path("id").asText();

            try {
                resumeThread(threadId);
            } catch (CodexRpcException ignored) {
                // A scheduled reconciler will retry waking persisted queued work.
            }
            return new DispatchReceipt(queueId, null);
        } catch (CodexRpcException queueFailure) {
            if (!isQueueUnavailable(queueFailure)) throw queueFailure;
        }

        ObjectNode params = mapper.createObjectNode();
        params.put("threadId", threadId);
        params.set("input", textInput(prompt));
        JsonNode result = client.request("turn/start", params);
        String turnId = result.path("turn").path("id").asText();
        return new DispatchReceipt(null, turnId);
    }

    @Override
    public void resumeThread(String threadId) {
        ObjectNode params = mapper.createObjectNode();
        params.put("threadId", threadId);
        client.request("thread/resume", params);
    }

    @Override
    public void interruptTurn(String threadId, String turnId) {
        ObjectNode params = mapper.createObjectNode();
        params.put("threadId", threadId);
        params.put("turnId", turnId);
        client.request("turn/interrupt", params);
    }

    private boolean isQueueUnavailable(Throwable failure) {
        Throwable current = failure;
        while (current != null) {
            String message = current.getMessage();
            if (message != null) {
                String normalized = message.toLowerCase(Locale.ROOT);
                if (normalized.contains("experimental")
                        || normalized.contains("method not found")
                        || normalized.contains("user message queue is unavailable")) return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private ArrayNode textInput(String prompt) {
        ArrayNode input = mapper.createArrayNode();
        ObjectNode text = mapper.createObjectNode();
        text.put("type", "text");
        text.put("text", prompt);
        input.add(text);
        return input;
    }

    private ArrayNode agenticformTools() {
        ArrayNode tools = mapper.createArrayNode();
        ObjectNode namespace = mapper.createObjectNode();
        namespace.put("type", "namespace");
        namespace.put("name", "agenticform");
        namespace.put("description", "Coordinate agents, communicate with one or many project agents, inspect deterministic policy, hand off operations, and request governed runbooks.");
        ArrayNode namespaceTools = namespace.putArray("tools");

        ObjectNode listAgents = mapper.createObjectNode();
        listAgents.put("type", "function");
        listAgents.put("name", "list_agents");
        listAgents.put("description", "List Agenticform agents in this project, including role, responsibility, system-managed state, execution node, and current status.");
        ObjectNode listSchema = listAgents.putObject("inputSchema");
        listSchema.put("type", "object");
        listSchema.putObject("properties");
        listSchema.put("additionalProperties", false);
        namespaceTools.add(listAgents);

        ObjectNode sendMessage = mapper.createObjectNode();
        sendMessage.put("type", "function");
        sendMessage.put("name", "send_message");
        sendMessage.put("description", "Send a durable direct asynchronous message to one Agenticform agent. Replies are direct by default. Do not send acknowledgement-only messages.");
        ObjectNode sendSchema = sendMessage.putObject("inputSchema");
        sendSchema.put("type", "object");
        ObjectNode properties = sendSchema.putObject("properties");
        property(properties, "targetAgentId", "string", "Agenticform agent UUID returned by list_agents.");
        addMessageType(properties);
        property(properties, "subject", "string", "Short message subject.");
        property(properties, "content", "string", "Message body with the minimum context the receiving agent needs.");
        property(properties, "replyToMessageId", "string", "Optional message UUID when replying to an incoming Agenticform message.");
        ArrayNode required = sendSchema.putArray("required");
        required.add("targetAgentId");
        required.add("type");
        required.add("subject");
        required.add("content");
        sendSchema.put("additionalProperties", false);
        namespaceTools.add(sendMessage);

        ObjectNode broadcast = mapper.createObjectNode();
        broadcast.put("type", "function");
        broadcast.put("name", "broadcast_message");
        broadcast.put("description", "Send one durable logical message to multiple same-project agents. Recipients are resolved and snapshotted when sent. Use MULTICAST for explicit agent IDs, ROLE for a role, GROUP for a configured group, or PROJECT_BROADCAST for all other active project agents. Never use for acknowledgement-only fanout.");
        ObjectNode broadcastSchema = broadcast.putObject("inputSchema");
        broadcastSchema.put("type", "object");
        ObjectNode broadcastProperties = broadcastSchema.putObject("properties");
        ObjectNode audience = broadcastProperties.putObject("audienceType");
        audience.put("type", "string");
        ArrayNode audienceValues = audience.putArray("enum");
        for (String value : new String[]{"MULTICAST", "ROLE", "GROUP", "PROJECT_BROADCAST"}) audienceValues.add(value);
        ObjectNode agentIds = broadcastProperties.putObject("agentIds");
        agentIds.put("type", "array");
        agentIds.putObject("items").put("type", "string");
        ObjectNode role = broadcastProperties.putObject("role");
        role.put("type", "string");
        ArrayNode roles = role.putArray("enum");
        roles.add("GENERAL");
        roles.add("OPERATIONAL");
        property(broadcastProperties, "groupId", "string", "Configured agent group UUID for GROUP audience.");
        addMessageType(broadcastProperties);
        property(broadcastProperties, "subject", "string", "Short message subject shared by all recipients.");
        property(broadcastProperties, "content", "string", "Message body with context needed by all recipients.");
        ArrayNode broadcastRequired = broadcastSchema.putArray("required");
        broadcastRequired.add("audienceType");
        broadcastRequired.add("type");
        broadcastRequired.add("subject");
        broadcastRequired.add("content");
        broadcastSchema.put("additionalProperties", false);
        namespaceTools.add(broadcast);

        ObjectNode handoff = mapper.createObjectNode();
        handoff.put("type", "function");
        handoff.put("name", "handoff_to_operations");
        handoff.put("description", "Send a durable handoff/request/blocker directly to this project's default Operational Agent. Prefer this from coding/reviewer/general agents for CI/CD, release, deploy, migration, backup, rollback, and operational verification work.");
        ObjectNode handoffSchema = handoff.putObject("inputSchema");
        handoffSchema.put("type", "object");
        ObjectNode handoffProperties = handoffSchema.putObject("properties");
        ObjectNode handoffType = handoffProperties.putObject("type");
        handoffType.put("type", "string");
        ArrayNode handoffTypes = handoffType.putArray("enum");
        handoffTypes.add("HANDOFF");
        handoffTypes.add("REQUEST");
        handoffTypes.add("BLOCKER");
        property(handoffProperties, "subject", "string", "Short operational handoff subject.");
        property(handoffProperties, "content", "string", "Minimum context needed by the Operational Agent, including candidate revision/PR/SHA and desired outcome when known.");
        ArrayNode handoffRequired = handoffSchema.putArray("required");
        handoffRequired.add("subject");
        handoffRequired.add("content");
        handoffSchema.put("additionalProperties", false);
        namespaceTools.add(handoff);

        ObjectNode listPolicyRules = mapper.createObjectNode();
        listPolicyRules.put("type", "function");
        listPolicyRules.put("name", "list_policy_rules");
        listPolicyRules.put("description", "List enabled deterministic policy rules applicable to this agent's current task, including scope, action, environment, effect, and precedence semantics.");
        ObjectNode listPolicySchema = listPolicyRules.putObject("inputSchema");
        listPolicySchema.put("type", "object");
        listPolicySchema.putObject("properties");
        listPolicySchema.put("additionalProperties", false);
        namespaceTools.add(listPolicyRules);

        ObjectNode listRunbooks = mapper.createObjectNode();
        listRunbooks.put("type", "function");
        listRunbooks.put("name", "list_runbooks");
        listRunbooks.put("description", "List enabled deterministic operational runbooks for this project. General agents may inspect them, but only the Operational Agent may request execution.");
        ObjectNode listRunbooksSchema = listRunbooks.putObject("inputSchema");
        listRunbooksSchema.put("type", "object");
        listRunbooksSchema.putObject("properties");
        listRunbooksSchema.put("additionalProperties", false);
        namespaceTools.add(listRunbooks);

        ObjectNode requestOperation = mapper.createObjectNode();
        requestOperation.put("type", "function");
        requestOperation.put("name", "request_operation");
        requestOperation.put("description", "Operational-Agent-only: request execution of a registered deterministic runbook. Agenticform evaluates its policy action automatically. ALLOW queues it, REQUIRE_HUMAN waits for a human, and DENY refuses it.");
        ObjectNode requestOperationSchema = requestOperation.putObject("inputSchema");
        requestOperationSchema.put("type", "object");
        ObjectNode operationProperties = requestOperationSchema.putObject("properties");
        property(operationProperties, "runbookKey", "string", "Runbook key returned by list_runbooks.");
        ObjectNode operationParameters = operationProperties.putObject("parameters");
        operationParameters.put("type", "object");
        ObjectNode parameterValueSchema = mapper.createObjectNode();
        parameterValueSchema.put("type", "string");
        operationParameters.set("additionalProperties", parameterValueSchema);
        requestOperationSchema.putArray("required").add("runbookKey");
        requestOperationSchema.put("additionalProperties", false);
        namespaceTools.add(requestOperation);

        ObjectNode operationStatus = mapper.createObjectNode();
        operationStatus.put("type", "function");
        operationStatus.put("name", "get_operation_status");
        operationStatus.put("description", "Read the current state and step summaries for a previously requested operation run in this project.");
        ObjectNode operationStatusSchema = operationStatus.putObject("inputSchema");
        operationStatusSchema.put("type", "object");
        ObjectNode statusProperties = operationStatusSchema.putObject("properties");
        property(statusProperties, "runId", "string", "Operation run UUID returned by request_operation.");
        operationStatusSchema.putArray("required").add("runId");
        operationStatusSchema.put("additionalProperties", false);
        namespaceTools.add(operationStatus);

        ObjectNode requestAction = mapper.createObjectNode();
        requestAction.put("type", "function");
        requestAction.put("name", "request_action");
        requestAction.put("description", "Evaluate a semantic action through Agenticform's deterministic policy engine. Use for governed actions that do not already have a registered runbook. The call returns immediately for ALLOW/DENY and blocks for REQUIRE_HUMAN.");
        ObjectNode requestActionSchema = requestAction.putObject("inputSchema");
        requestActionSchema.put("type", "object");
        ObjectNode actionProperties = requestActionSchema.putObject("properties");
        property(actionProperties, "action", "string", "Policy action name, for example PRODUCTION_DEPLOY, PRODUCTION_DML, DELETE_DATA, MERGE_MAIN, or another configured action.");
        property(actionProperties, "environment", "string", "Target environment such as production, staging, development, or * when environment-independent.");
        property(actionProperties, "summary", "string", "Concise description of the exact action to evaluate.");
        property(actionProperties, "details", "string", "Relevant target, command, resource, and scope for audit and human review.");
        ArrayNode actionRequired = requestActionSchema.putArray("required");
        actionRequired.add("action");
        actionRequired.add("summary");
        actionRequired.add("details");
        requestActionSchema.put("additionalProperties", false);
        namespaceTools.add(requestAction);

        ObjectNode protectedAction = mapper.createObjectNode();
        protectedAction.put("type", "function");
        protectedAction.put("name", "request_protected_action");
        protectedAction.put("description", "Compatibility helper for default protected actions. Prefer request_operation for registered runbooks and request_action for other configurable policy actions.");
        ObjectNode protectedSchema = protectedAction.putObject("inputSchema");
        protectedSchema.put("type", "object");
        ObjectNode protectedProperties = protectedSchema.putObject("properties");
        ObjectNode kind = protectedProperties.putObject("kind");
        kind.put("type", "string");
        ArrayNode kinds = kind.putArray("enum");
        kinds.add("PRODUCTION_DEPLOY");
        kinds.add("PRODUCTION_DML");
        kinds.add("DELETE_DATA");
        property(protectedProperties, "environment", "string", "Target environment. Use production for production deploy/DML.");
        property(protectedProperties, "summary", "string", "Concise description of the exact governed action.");
        property(protectedProperties, "details", "string", "Relevant target/environment/command/data scope so the decision is auditable.");
        ArrayNode protectedRequired = protectedSchema.putArray("required");
        protectedRequired.add("kind");
        protectedRequired.add("summary");
        protectedRequired.add("details");
        protectedSchema.put("additionalProperties", false);
        namespaceTools.add(protectedAction);

        tools.add(namespace);
        return tools;
    }

    private void addMessageType(ObjectNode properties) {
        ObjectNode type = properties.putObject("type");
        type.put("type", "string");
        ArrayNode messageTypes = type.putArray("enum");
        for (String value : new String[]{"QUESTION", "ANSWER", "REQUEST", "RESULT", "HANDOFF", "REVIEW_REQUEST", "REVIEW_RESULT", "INFORMATION", "BLOCKER"}) {
            messageTypes.add(value);
        }
    }

    private void property(ObjectNode properties, String name, String type, String description) {
        ObjectNode property = properties.putObject(name);
        property.put("type", type);
        property.put("description", description);
    }
}
