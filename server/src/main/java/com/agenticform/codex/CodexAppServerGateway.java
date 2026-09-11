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
            You operate under Agenticform human-control governance.
            Continue normal development work autonomously until blocked or until you genuinely need user input.
            Before executing ANY of these protected actions, you MUST call agenticform.request_protected_action and wait for the human decision:
            1. deploying or releasing to a production environment;
            2. mutating production data with DML or equivalent write operations;
            3. deleting persistent/business data, including DELETE/TRUNCATE/DROP or equivalent destructive API/database operations.
            Protected-action approval is valid once for exactly the described action and is never reusable for a later protected action.
            Do not request protected-action approval for normal coding, tests, builds, dependency installation, development/staging work, ordinary network access, or agent-to-agent communication.
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
        // Keep the execution boundary deterministic regardless of the host's global Codex config.
        // Agenticform is the user-facing approval client and applies HITL/HOTL policy itself.
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
        namespace.put("description", "Coordinate with Agenticform agents and request the mandatory human gate for protected production/destructive actions.");
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

        ObjectNode protectedAction = mapper.createObjectNode();
        protectedAction.put("type", "function");
        protectedAction.put("name", "request_protected_action");
        protectedAction.put("description", "MANDATORY human gate immediately before a production deployment, production data DML/mutation, or deletion of persistent/business data. The call blocks until the human approves or declines. Approval is one-shot and must not be reused.");
        ObjectNode protectedSchema = protectedAction.putObject("inputSchema");
        protectedSchema.put("type", "object");
        ObjectNode protectedProperties = protectedSchema.putObject("properties");
        ObjectNode kind = protectedProperties.putObject("kind");
        kind.put("type", "string");
        ArrayNode kinds = kind.putArray("enum");
        kinds.add("PRODUCTION_DEPLOY");
        kinds.add("PRODUCTION_DML");
        kinds.add("DELETE_DATA");
        property(protectedProperties, "summary", "string", "Concise description of the exact protected action that will run after approval.");
        property(protectedProperties, "details", "string", "Relevant target/environment/command/data scope so the human can make an informed decision.");
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
