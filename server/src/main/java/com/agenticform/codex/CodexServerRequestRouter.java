package com.agenticform.codex;

import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;

@Component
public class CodexServerRequestRouter {
    private final CopyOnWriteArrayList<CodexJsonRpcClient.ServerRequestHandler> handlers = new CopyOnWriteArrayList<>();

    public void register(CodexJsonRpcClient.ServerRequestHandler handler) {
        handlers.addIfAbsent(handler);
    }

    public CompletionStage<JsonNode> route(CodexJsonRpcClient.ServerRequest request) {
        for (CodexJsonRpcClient.ServerRequestHandler handler : handlers) {
            if (!handler.supports(request.method())) continue;
            try {
                return handler.handle(request);
            } catch (Exception error) {
                return CompletableFuture.failedFuture(error);
            }
        }
        return CompletableFuture.failedFuture(
                new IllegalArgumentException("Unsupported server request: " + request.method()));
    }
}
