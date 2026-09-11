package com.agenticform.codex;

import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.Locale;

@Component
public class CodexAppServerGateway implements CodexGateway {
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

            // Queue persistence and wake-up are deliberately separate. Once queue/add succeeds,
            // falling back to turn/start would risk executing the same user intent twice.
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
}
