package com.agenticform.node;

import com.agenticform.codex.CodexEventBridge;
import com.agenticform.codex.CodexJsonRpcClient;
import com.agenticform.codex.CodexServerRequestRouter;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.LongNode;

import java.util.UUID;
import java.util.concurrent.CompletionStage;

@RestController
@RequestMapping("/api/nodes/{nodeId}/codex")
public class NodeCodexBridgeController {
    private final NodeSignatureVerifier signatures;
    private final CodexServerRequestRouter router;
    private final CodexEventBridge events;
    private final ObjectMapper mapper;

    public NodeCodexBridgeController(NodeSignatureVerifier signatures,
                                     CodexServerRequestRouter router,
                                     CodexEventBridge events,
                                     ObjectMapper mapper) {
        this.signatures = signatures;
        this.router = router;
        this.events = events;
        this.mapper = mapper;
    }

    @PostMapping("/notification")
    public void notification(@PathVariable UUID nodeId,
                             @RequestHeader("X-AF-Timestamp") String timestamp,
                             @RequestHeader("X-AF-Signature") String signature,
                             @RequestBody byte[] body) throws Exception {
        String path = "/api/nodes/" + nodeId + "/codex/notification";
        signatures.verify(nodeId, timestamp, signature, "POST", path, body);
        BridgeMessage message = mapper.readValue(body, BridgeMessage.class);
        events.handleRemote(nodeId, new CodexJsonRpcClient.Notification(message.method(), message.params()));
    }

    @PostMapping("/server-request")
    public CompletionStage<JsonNode> serverRequest(@PathVariable UUID nodeId,
                                                    @RequestHeader("X-AF-Timestamp") String timestamp,
                                                    @RequestHeader("X-AF-Signature") String signature,
                                                    @RequestBody byte[] body) throws Exception {
        String path = "/api/nodes/" + nodeId + "/codex/server-request";
        signatures.verify(nodeId, timestamp, signature, "POST", path, body);
        BridgeMessage message = mapper.readValue(body, BridgeMessage.class);
        JsonNode requestId = message.requestId() == null ? LongNode.valueOf(0L) : message.requestId();
        return router.route(new CodexJsonRpcClient.ServerRequest(requestId, message.method(), message.params()));
    }

    public record BridgeMessage(JsonNode requestId, String method, JsonNode params) {}
}
