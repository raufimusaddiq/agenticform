package com.agenticform.approval;

import com.agenticform.codex.CodexJsonRpcClient;
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
        return service.receive(request);
    }
}
