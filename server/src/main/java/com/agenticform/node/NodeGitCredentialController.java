package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectService;
import com.agenticform.project.ProjectSourceType;
import com.agenticform.runtime.RuntimeType;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.NoSuchElementException;
import java.util.UUID;

@RestController
@RequestMapping("/api/nodes/{nodeId}/git-credential")
public class NodeGitCredentialController {
    private final NodeSignatureVerifier signatures;
    private final AgentRepository agents;
    private final ProjectService projects;
    private final GitHubAppCredentialBroker broker;
    private final ObjectMapper mapper;

    public NodeGitCredentialController(NodeSignatureVerifier signatures,
                                       AgentRepository agents,
                                       ProjectService projects,
                                       GitHubAppCredentialBroker broker,
                                       ObjectMapper mapper) {
        this.signatures = signatures;
        this.agents = agents;
        this.projects = projects;
        this.broker = broker;
        this.mapper = mapper;
    }

    @PostMapping("/bootstrap")
    public CredentialResponse issueBootstrap(@PathVariable UUID nodeId,
                                             @RequestHeader("X-AF-Timestamp") String timestamp,
                                             @RequestHeader("X-AF-Nonce") String nonce,
                                             @RequestHeader("X-AF-Signature") String signature,
                                             @RequestBody byte[] body) throws Exception {
        return issue(nodeId, timestamp, nonce, signature, body, "bootstrap");
    }

    @PostMapping("/runtime")
    public CredentialResponse issueRuntime(@PathVariable UUID nodeId,
                                            @RequestHeader("X-AF-Timestamp") String timestamp,
                                            @RequestHeader("X-AF-Nonce") String nonce,
                                            @RequestHeader("X-AF-Signature") String signature,
                                            @RequestBody byte[] body) throws Exception {
        return issue(nodeId, timestamp, nonce, signature, body, "runtime");
    }

    private CredentialResponse issue(UUID nodeId, String timestamp, String nonce, String signature, byte[] body,
                                     String mode) throws Exception {
        String path = "/api/nodes/" + nodeId + "/git-credential/" + mode;
        signatures.verify(nodeId, timestamp, nonce, signature, "POST", path, body);
        CredentialRequest request = mapper.readValue(body, CredentialRequest.class);
        if (request.agentId() == null || request.projectId() == null || request.runtimeGeneration() <= 0
                || request.runtimeType() == null) {
            throw new IllegalArgumentException("agentId, projectId, runtimeGeneration, and runtimeType are required");
        }
        AgentEntity agent = agents.findById(request.agentId())
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + request.agentId()));
        if (!agent.ownsRuntimeAssignment(nodeId, request.runtimeGeneration(), request.runtimeType())) {
            throw new IllegalStateException("Git credential request belongs to a stale runtime generation");
        }
        boolean hasSession = request.runtimeSessionId() != null && !request.runtimeSessionId().isBlank();
        if ("bootstrap".equals(mode) && hasSession) {
            throw new IllegalArgumentException("Bootstrap Git credential request must not include a runtime session");
        }
        if ("bootstrap".equals(mode) && agent.getRuntimeSessionId() != null && !agent.getRuntimeSessionId().isBlank()) {
            throw new IllegalStateException("Bootstrap Git credential request is only valid before runtime binding");
        }
        if ("runtime".equals(mode) && !hasSession) {
            throw new IllegalArgumentException("Runtime Git credential request requires a runtime session");
        }
        if (hasSession && !agent.ownsRuntime(nodeId, request.runtimeGeneration(), request.runtimeType(), request.runtimeSessionId())) {
            throw new IllegalStateException("Git credential request belongs to a stale runtime session");
        }
        if (!request.projectId().equals(agent.getProjectId())) {
            throw new IllegalArgumentException("Agent belongs to another project");
        }
        ProjectEntity project = projects.get(request.projectId());
        if (project.getSourceType() != ProjectSourceType.GIT
                || project.getRepositoryUrl() == null
                || !project.getRepositoryUrl().equals(request.repositoryUrl())) {
            throw new IllegalArgumentException("Requested repository does not match the registered project source");
        }
        GitHubAppCredentialBroker.Credential credential = broker.issue(project.getRepositoryUrl());
        return new CredentialResponse(credential.username(), credential.password(), credential.expiresAt());
    }

    public record CredentialRequest(UUID agentId, UUID projectId, long runtimeGeneration, RuntimeType runtimeType,
                                    String runtimeSessionId, String repositoryUrl) {}
    public record CredentialResponse(String username, String password, Instant expiresAt) {}
}
