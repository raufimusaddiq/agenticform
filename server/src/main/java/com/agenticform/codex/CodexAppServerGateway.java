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
            Before an action matching a governed semantic action, call agenticform.request_action with the exact action name, environment, summary, and details and obey its result.
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
            if (!isQueueUnavailable(queueFailure)) {
                throw queueFailure;
            }
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
                        || normalized.contains("user message queue is unavailable")) {
                    return true;
                }
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
        namespace.put("description", "Coordinate with agents and evaluate actions against Agenticform deterministic policy.");
        ArrayNode namespaceTools = namespace.putArray("tools");

        ObjectNode listAgents = mapper.createObjectNode();
        listAgents.put("type", "function");
        listAgents.put("name", "list_agents");
        listAgents.put("description", "List Agenticform agents in this project, including responsibilities and current status. Use this before sending a message when the target agent id is unknown.");
        ObjectNode listSchema = listAgents.putObject("inputSchema");
        listSchema.put("type", "object");
        listSchema.putObject("properties");
        listSchema.put("additionalProperties", false);
        namespaceTools.add(listAgents);

        ObjectNode sendMessage = mapper.createObjectNode();
        sendMessage.put("type", "function");
        sendMessage.put("name", "send_message");
        sendMessage.put("description", "Send a durable asynchronous message to another Agenticform agent. Use for questions, requests, handoffs, reviews, blockers, and relevant information. Do not send acknowledgement-only messages.");
        ObjectNode sendSchema = sendMessage.putObject("inputSchema");
        sendSchema.put("type", "object");
        ObjectNode properties = sendSchema.putObject("properties");
        property(properties, "targetAgentId", "string", "Agenticform agent UUID returned by list_agents.");
        ObjectNode type = properties.putObject("type");
        type.put("type", "string");
        ArrayNode messageTypes = type.putArray("enum");
        for (String value : new String[]{"QUESTION", "ANSWER", "REQUEST", "RESULT", "HANDOFF", "REVIEW_REQUEST", "REVIEW_RESULT", "INFORMATION", "BLOCKER"}) {
            messageTypes.add(value);
        }
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

        ObjectNode listPolicyRules = mapper.createObjectNode();
        listPolicyRules.put("type", "function");
        listPolicyRules.put("name", "list_policy_rules");
        listPolicyRules.put("description", "List enabled deterministic policy rules applicable to this agent's current task, including scope, action, environment, effect, and precedence semantics.");
        ObjectNode listPolicySchema = listPolicyRules.putObject("inputSchema");
        listPolicySchema.put("type", "object");
        listPolicySchema.putObject("properties");
        listPolicySchema.put("additionalProperties", false);
        namespaceTools.add(listPolicyRules);

        ObjectNode requestAction = mapper.createObjectNode();
        requestAction.put("type", "function");
        requestAction.put("name", "request_action");
        requestAction.put("description", "Evaluate a semantic action through Agenticform's deterministic policy engine. The call returns immediately for ALLOW/DENY and blocks for REQUIRE_HUMAN.");
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
        protectedAction.put("description", "Compatibility helper for the default protected actions. Prefer request_action for configurable policy actions.");
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

    private void property(ObjectNode properties, String name, String type, String description) {
        ObjectNode property = properties.putObject(name);
        property.put("type", type);
        property.put("description", description);
    }
}
