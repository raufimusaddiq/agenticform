package com.agenticform.codex;

import com.agenticform.config.AgenticformProperties;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

@Component
public class CodexJsonRpcClient implements WebSocket.Listener {
    private final AgenticformProperties properties;
    private final ObjectMapper mapper;
    private final HttpClient httpClient = HttpClient.newHttpClient();
    private final AtomicLong requestSequence = new AtomicLong();
    private final Map<Long, CompletableFuture<JsonNode>> pending = new ConcurrentHashMap<>();
    private final CopyOnWriteArrayList<Consumer<Notification>> listeners = new CopyOnWriteArrayList<>();
    private final CopyOnWriteArrayList<ServerRequestHandler> serverRequestHandlers = new CopyOnWriteArrayList<>();
    private final StringBuilder incoming = new StringBuilder();
    private final Object connectionLock = new Object();

    private volatile WebSocket socket;
    private volatile boolean initialized;

    public CodexJsonRpcClient(AgenticformProperties properties, ObjectMapper mapper) {
        this.properties = properties;
        this.mapper = mapper;
    }

    public JsonNode request(String method, ObjectNode params) {
        ensureConnected();
        return sendRequest(method, params);
    }

    public void addNotificationListener(Consumer<Notification> listener) {
        listeners.add(listener);
    }

    public void addServerRequestHandler(ServerRequestHandler handler) {
        serverRequestHandlers.add(handler);
    }

    private void ensureConnected() {
        if (initialized && socket != null) {
            return;
        }
        synchronized (connectionLock) {
            if (initialized && socket != null) {
                return;
            }
            socket = httpClient.newWebSocketBuilder()
                    .buildAsync(properties.getCodex().getEndpoint(), this)
                    .join();

            ObjectNode capabilities = mapper.createObjectNode();
            capabilities.put("experimentalApi", properties.getCodex().isExperimentalApi());
            ObjectNode clientInfo = mapper.createObjectNode();
            clientInfo.put("name", "agenticform");
            clientInfo.put("version", "0.1.0");
            ObjectNode initialize = mapper.createObjectNode();
            initialize.set("clientInfo", clientInfo);
            initialize.set("capabilities", capabilities);
            sendRequest("initialize", initialize);

            ObjectNode initializedMessage = mapper.createObjectNode();
            initializedMessage.put("method", "initialized");
            sendText(initializedMessage);
            initialized = true;
        }
    }

    private JsonNode sendRequest(String method, ObjectNode params) {
        long id = requestSequence.incrementAndGet();
        ObjectNode message = mapper.createObjectNode();
        message.put("id", id);
        message.put("method", method);
        message.set("params", params);

        CompletableFuture<JsonNode> future = new CompletableFuture<>();
        pending.put(id, future);
        sendText(message);

        Duration timeout = properties.getCodex().getRequestTimeout();
        try {
            return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            pending.remove(id);
            throw new CodexRpcException("Codex request failed: " + method, e);
        }
    }

    private void sendText(JsonNode message) {
        try {
            socket.sendText(mapper.writeValueAsString(message), true).join();
        } catch (Exception e) {
            throw new CodexRpcException("Unable to write to Codex App Server", e);
        }
    }

    private void sendServerResult(JsonNode id, JsonNode result) {
        ObjectNode response = mapper.createObjectNode();
        response.set("id", id);
        response.set("result", result);
        sendText(response);
    }

    private void sendServerError(JsonNode id, int code, String message) {
        ObjectNode response = mapper.createObjectNode();
        response.set("id", id);
        ObjectNode error = response.putObject("error");
        error.put("code", code);
        error.put("message", message);
        sendText(response);
    }

    @Override
    public void onOpen(WebSocket webSocket) {
        webSocket.request(1);
    }

    @Override
    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
        String complete = null;
        synchronized (incoming) {
            incoming.append(data);
            if (last) {
                complete = incoming.toString();
                incoming.setLength(0);
            }
        }
        if (complete != null) {
            handleMessage(complete);
        }
        webSocket.request(1);
        return CompletableFuture.completedFuture(null);
    }

    private void handleMessage(String raw) {
        try {
            JsonNode message = mapper.readTree(raw);

            if (message.has("id") && message.has("method")) {
                ServerRequest request = new ServerRequest(
                        message.get("id"), message.get("method").asText(), message.get("params"));
                CompletableFuture.runAsync(() -> handleServerRequest(request));
                return;
            }

            if (message.has("id")) {
                long id = message.get("id").asLong();
                CompletableFuture<JsonNode> future = pending.remove(id);
                if (future != null) {
                    if (message.has("error")) {
                        future.completeExceptionally(new CodexRpcException(message.get("error").toString()));
                    } else {
                        future.complete(message.get("result"));
                    }
                }
                return;
            }

            if (message.has("method")) {
                Notification notification = new Notification(
                        message.get("method").asText(), message.get("params"));
                listeners.forEach(listener -> listener.accept(notification));
            }
        } catch (Exception ignored) {
            // Malformed transport messages are isolated from the reader loop; diagnostics will be added in observability work.
        }
    }

    private void handleServerRequest(ServerRequest request) {
        for (ServerRequestHandler handler : serverRequestHandlers) {
            if (!handler.supports(request.method())) {
                continue;
            }
            try {
                CompletionStage<JsonNode> response = handler.handle(request);
                response.whenComplete((result, error) -> {
                    if (error != null) {
                        Throwable cause = error.getCause() == null ? error : error.getCause();
                        sendServerError(request.id(), -32000,
                                cause.getMessage() == null ? "Agenticform server request failed" : cause.getMessage());
                    } else {
                        sendServerResult(request.id(), result);
                    }
                });
            } catch (Exception error) {
                sendServerError(request.id(), -32000,
                        error.getMessage() == null ? "Agenticform server request failed" : error.getMessage());
            }
            return;
        }
        sendServerError(request.id(), -32601, "Unsupported server request: " + request.method());
    }

    @Override
    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
        failPending("Codex App Server connection closed: " + reason);
        initialized = false;
        socket = null;
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public void onError(WebSocket webSocket, Throwable error) {
        failPending("Codex App Server connection failed: " + error.getMessage());
        initialized = false;
        socket = null;
    }

    @Override
    public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
        webSocket.request(1);
        return CompletableFuture.completedFuture(null);
    }

    private void failPending(String message) {
        pending.values().forEach(future -> future.completeExceptionally(new CodexRpcException(message)));
        pending.clear();
    }

    @PreDestroy
    void close() {
        WebSocket current = socket;
        if (current != null) {
            current.sendClose(WebSocket.NORMAL_CLOSURE, "shutdown");
        }
    }

    public record Notification(String method, JsonNode params) {}
    public record ServerRequest(JsonNode id, String method, JsonNode params) {}

    public interface ServerRequestHandler {
        boolean supports(String method);
        CompletionStage<JsonNode> handle(ServerRequest request);
    }
}
