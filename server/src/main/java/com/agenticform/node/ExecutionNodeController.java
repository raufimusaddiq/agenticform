package com.agenticform.node;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/nodes")
public class ExecutionNodeController {
    private final ExecutionNodeService service;
    private final NodeCommandCompletionHandler completions;
    private final NodeSignatureVerifier signatures;
    private final ObjectMapper mapper;

    public ExecutionNodeController(ExecutionNodeService service,
                                   NodeCommandCompletionHandler completions,
                                   NodeSignatureVerifier signatures,
                                   ObjectMapper mapper) {
        this.service = service;
        this.completions = completions;
        this.signatures = signatures;
        this.mapper = mapper;
    }

    @GetMapping
    public List<ExecutionNodeEntity> list() { return service.list(); }

    @PostMapping("/enrollments")
    public ExecutionNodeService.Enrollment createEnrollment(@Valid @RequestBody CreateEnrollmentRequest request) {
        return service.createEnrollment(request.name(), request.trustLevel());
    }

    @PostMapping("/enroll")
    public ExecutionNodeService.EnrollmentResult enroll(@Valid @RequestBody EnrollRequest request) {
        return service.enroll(request.token(), request.publicKeyBase64());
    }

    @PostMapping("/{nodeId}/heartbeat")
    public ExecutionNodeEntity heartbeat(@PathVariable UUID nodeId,
                                         @RequestHeader("X-AF-Timestamp") String timestamp,
                                         @RequestHeader("X-AF-Nonce") String nonce,
                                         @RequestHeader("X-AF-Signature") String signature,
                                         @RequestBody byte[] body) throws Exception {
        String path = "/api/nodes/" + nodeId + "/heartbeat";
        signatures.verify(nodeId, timestamp, nonce, signature, "POST", path, body);
        HeartbeatRequest request = mapper.readValue(body, HeartbeatRequest.class);
        return service.heartbeat(nodeId, new ExecutionNodeService.Heartbeat(
                request.labelsJson(), request.capabilitiesJson(), request.maxAgents(),
                request.os(), request.arch(), request.hostname(), request.nodeVersion(), request.codexVersion(),
                request.cpuCores(), request.memoryMb(), request.diskFreeMb()));
    }

    @GetMapping("/{nodeId}/commands/next")
    public ResponseEntity<NodeCommandEntity> nextCommand(@PathVariable UUID nodeId,
                                                          @RequestHeader("X-AF-Timestamp") String timestamp,
                                                          @RequestHeader("X-AF-Nonce") String nonce,
                                                          @RequestHeader("X-AF-Signature") String signature) {
        String path = "/api/nodes/" + nodeId + "/commands/next";
        signatures.verify(nodeId, timestamp, nonce, signature, "GET", path, new byte[0]);
        NodeCommandEntity command = service.leaseNext(nodeId);
        return command == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(command);
    }

    @PostMapping("/{nodeId}/commands/{commandId}/complete")
    public NodeCommandEntity complete(@PathVariable UUID nodeId,
                                      @PathVariable UUID commandId,
                                      @RequestHeader("X-AF-Timestamp") String timestamp,
                                      @RequestHeader("X-AF-Nonce") String nonce,
                                      @RequestHeader("X-AF-Signature") String signature,
                                      @RequestBody byte[] body) throws Exception {
        String path = "/api/nodes/" + nodeId + "/commands/" + commandId + "/complete";
        signatures.verify(nodeId, timestamp, nonce, signature, "POST", path, body);
        CompleteCommandRequest request = mapper.readValue(body, CompleteCommandRequest.class);
        NodeCommandEntity command = service.complete(nodeId, commandId,
                request.success(), request.resultJson(), request.error());
        completions.handle(command, request.success(), request.resultJson(), request.error());
        return command;
    }

    @PostMapping("/{nodeId}/status")
    public ExecutionNodeEntity status(@PathVariable UUID nodeId, @Valid @RequestBody UpdateStatusRequest request) {
        return service.setStatus(nodeId, request.status());
    }

    public record CreateEnrollmentRequest(@NotBlank String name, NodeTrustLevel trustLevel) {}
    public record EnrollRequest(@NotBlank String token, @NotBlank String publicKeyBase64) {}
    public record HeartbeatRequest(String labelsJson, String capabilitiesJson, int maxAgents,
                                   String os, String arch, String hostname, String nodeVersion,
                                   String codexVersion, Integer cpuCores, Long memoryMb, Long diskFreeMb) {}
    public record CompleteCommandRequest(boolean success, String resultJson, String error) {}
    public record UpdateStatusRequest(@NotNull ExecutionNodeStatus status) {}
}
