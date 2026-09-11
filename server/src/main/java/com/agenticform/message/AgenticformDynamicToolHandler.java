package com.agenticform.message;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.codex.CodexJsonRpcClient;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Component
public class AgenticformDynamicToolHandler implements CodexJsonRpcClient.ServerRequestHandler {
    private static final String METHOD = "item/tool/call";
    private static final String NAMESPACE = "agenticform";

    private final CodexJsonRpcClient client;
    private final AgentRepository agentRepository;
    private final AgentMessageService messageService;
    private final ObjectMapper mapper;

    public AgenticformDynamicToolHandler(CodexJsonRpcClient client, AgentRepository agentRepository,
                                         AgentMessageService messageService, ObjectMapper mapper) {
        this.client = client;
        this.agentRepository = agentRepository;
        this.messageService = messageService;
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
    public JsonNode handle(CodexJsonRpcClient.ServerRequest request) {
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
            case "list_agents" -> listAgents(source);
            case "send_message" -> sendMessage(source, arguments);
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
            row.put("responsibility", agent.getResponsibility());
            row.put("status", agent.getStatus().name());
            row.put("queueMode", agent.getQueueMode().name());
            row.put("self", agent.getId().equals(source.getId()));
            rows.add(row);
        }

        ObjectNode payload = mapper.createObjectNode();
        payload.put("projectId", source.getProjectId().toString());
        payload.set("agents", rows);
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
