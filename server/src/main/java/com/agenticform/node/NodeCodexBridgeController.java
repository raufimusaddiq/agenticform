package com.agenticform.node;

import com.agenticform.codex.CodexEventBridge;
import com.agenticform.codex.CodexJsonRpcClient;
import org.springframework.web.bind.annotation.GetMapping;
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

@RestController
@RequestMapping("/api/nodes/{nodeId}/codex")
public class NodeCodexBridgeController {
    private final NodeSignatureVerifier signatures;
    private final RemoteCodexInteractionService interactions;
    private final CodexEventBridge events;
    private final ObjectMapper mapper;

    public NodeCodexBridgeController(NodeSignatureVerifier signatures,
                                     RemoteCodexInteractionService interactions,
                                     CodexEventBridge events,
                                     ObjectMapper mapper) {
        this.signatures = signatures;
        this.interactions = interactions;
        this.events = events;
        this.mapper = mapper;
    }

    @PostMapping("/notification")
    public void notification(@PathVariable UUID nodeId,
                             @RequestHeader("X-AF-Timestamp") String timestamp,
                             @RequestHeader("X-AF-Nonce") String nonce,
                             @RequestHeader("X-AF-Signature") String signature,
                             @RequestBody byte[] body) throws Exception {
        String path = "/api/nodes/" + nodeId + "/codex/notification";
        signatures.verify(nodeId, timestamp, nonce, signature, "POST", path, body);
        BridgeMessage message = mapper.readValue(body, BridgeMessage.class);
        events.handleRemote(nodeId, message.runtimeGeneration(),
                new CodexJsonRpcClient.Notification(message.method(), message.params()));
    }

    @PostMapping("/server-request")
    public RemoteCodexInteractionService.InteractionView serverRequest(
            @PathVariable UUID nodeId,
            @RequestHeader("X-AF-Timestamp") String timestamp,
            @RequestHeader("X-AF-Nonce") String nonce,
            @RequestHeader("X-AF-Signature") String signature,
            @RequestBody byte[] body) throws Exception {
        String path = "/api/nodes/" + nodeId + "/codex/server-request";
        signatures.verify(nodeId, timestamp, nonce, signature, "POST", path, body);
        BridgeMessage message = mapper.readValue(body, BridgeMessage.class);
        JsonNode requestId = message.requestId() == null ? LongNode.valueOf(0L) : message.requestId();
        return interactions.begin(nodeId, message.runtimeGeneration(),
                new CodexJsonRpcClient.ServerRequest(requestId, message.method(), message.params()));
    }

    @GetMapping("/server-request/{interactionId}")
    public RemoteCodexInteractionService.InteractionView poll(
            @PathVariable UUID nodeId,
            @PathVariable UUID interactionId,
            @RequestHeader("X-AF-Timestamp") String timestamp,
            @RequestHeader("X-AF-Nonce") String nonce,
            @RequestHeader("X-AF-Signature") String signature) {
        String path = "/api/nodes/" + nodeId + "/codex/server-request/" + interactionId;
        signatures.verify(nodeId, timestamp, nonce, signature, "GET", path, new byte[0]);
        return interactions.poll(nodeId, interactionId);
    }

    @PostMapping("/server-request/{interactionId}/ack")
    public RemoteCodexInteractionService.InteractionView acknowledge(
            @PathVariable UUID nodeId,
            @PathVariable UUID interactionId,
            @RequestHeader("X-AF-Timestamp") String timestamp,
            @RequestHeader("X-AF-Nonce") String nonce,
            @RequestHeader("X-AF-Signature") String signature) {
        String path = "/api/nodes/" + nodeId + "/codex/server-request/" + interactionId + "/ack";
        signatures.verify(nodeId, timestamp, nonce, signature, "POST", path, new byte[0]);
        return interactions.acknowledge(nodeId, interactionId);
    }

    public record BridgeMessage(JsonNode requestId, String method, JsonNode params, long runtimeGeneration) {}
}
