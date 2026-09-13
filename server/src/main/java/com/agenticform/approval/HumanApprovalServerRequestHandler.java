package com.agenticform.approval;

import com.agenticform.codex.CodexJsonRpcClient;
import com.agenticform.runtime.RuntimeApprovalRequest;
import com.agenticform.runtime.RuntimeType;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.util.Set;
import java.util.concurrent.CompletionStage;

@Component
public class HumanApprovalServerRequestHandler implements CodexJsonRpcClient.ServerRequestHandler {
    private static final Set<String> METHODS = Set.of(
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "item/tool/requestUserInput"
    );

    private final CodexJsonRpcClient client;
    private final HumanApprovalService service;

    public HumanApprovalServerRequestHandler(CodexJsonRpcClient client, HumanApprovalService service) {
        this.client = client;
        this.service = service;
    }

    @PostConstruct
    void register() {
        client.addServerRequestHandler(this);
    }

    @Override
    public boolean supports(String method) {
        return METHODS.contains(method);
    }

    @Override
    public CompletionStage<JsonNode> handle(CodexJsonRpcClient.ServerRequest request) {
        JsonNode params = request.params();
        String sessionId = params.path("threadId").asText(null);
        if (sessionId == null || sessionId.isBlank()) throw new IllegalArgumentException("Codex approval is missing threadId");
        String requestId = request.id().isTextual() ? request.id().asText() : request.id().toString();
        return service.receive(new RuntimeApprovalRequest(requestId, RuntimeType.CODEX, sessionId, request.method(), params));
    }
}
