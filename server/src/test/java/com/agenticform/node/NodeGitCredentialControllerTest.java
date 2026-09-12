package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectService;
import com.agenticform.project.ProjectSourceType;
import com.agenticform.runtime.RuntimeType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class NodeGitCredentialControllerTest {
    @Mock NodeSignatureVerifier signatures;
    @Mock AgentRepository agents;
    @Mock ProjectService projects;
    @Mock GitHubAppCredentialBroker broker;
    @Mock AgentEntity agent;
    @Mock ProjectEntity project;

    private NodeGitCredentialController controller;
    private ObjectMapper mapper;

    @BeforeEach
    void setUp() {
        mapper = new ObjectMapper();
        controller = new NodeGitCredentialController(signatures, agents, projects, broker, mapper);
    }

    @Test
    void currentRuntimeGetsCredentialOnlyForRegisteredRepository() throws Exception {
        UUID nodeId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        String repositoryUrl = "https://github.com/acme/private-repo.git";
        byte[] body = request(agentId, projectId, 4L, repositoryUrl);

        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.getRuntimeSessionId()).thenReturn(null);
        when(agent.ownsRuntime(nodeId, 4L, RuntimeType.CODEX, null)).thenReturn(true);
        when(agent.getProjectId()).thenReturn(projectId);
        when(projects.get(projectId)).thenReturn(project);
        when(project.getSourceType()).thenReturn(ProjectSourceType.GIT);
        when(project.getRepositoryUrl()).thenReturn(repositoryUrl);
        Instant expiresAt = Instant.now().plusSeconds(1800);
        when(broker.issue(repositoryUrl)).thenReturn(
                new GitHubAppCredentialBroker.Credential("x-access-token", "short-lived-token", expiresAt));

        NodeGitCredentialController.CredentialResponse response = controller.issue(
                nodeId, "timestamp", "nonce", "signature", body);

        assertEquals("x-access-token", response.username());
        assertEquals("short-lived-token", response.password());
        assertEquals(expiresAt, response.expiresAt());
        verify(signatures).verify(eq(nodeId), eq("timestamp"), eq("nonce"), eq("signature"),
                eq("POST"), eq("/api/nodes/" + nodeId + "/git-credential"), eq(body));
    }

    @Test
    void staleRuntimeCannotRequestCredential() throws Exception {
        UUID nodeId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        byte[] body = request(agentId, projectId, 3L, "https://github.com/acme/private-repo.git");

        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.getRuntimeSessionId()).thenReturn(null);
        when(agent.ownsRuntime(nodeId, 3L, RuntimeType.CODEX, null)).thenReturn(false);

        assertThrows(IllegalStateException.class,
                () -> controller.issue(nodeId, "timestamp", "nonce", "signature", body));
        verify(broker, never()).issue(any());
    }

    @Test
    void runtimeCannotRequestCredentialForDifferentRepository() throws Exception {
        UUID nodeId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        byte[] body = request(agentId, projectId, 2L, "https://github.com/acme/other.git");

        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.getRuntimeSessionId()).thenReturn(null);
        when(agent.ownsRuntime(nodeId, 2L, RuntimeType.CODEX, null)).thenReturn(true);
        when(agent.getProjectId()).thenReturn(projectId);
        when(projects.get(projectId)).thenReturn(project);
        when(project.getSourceType()).thenReturn(ProjectSourceType.GIT);
        when(project.getRepositoryUrl()).thenReturn("https://github.com/acme/registered.git");

        assertThrows(IllegalArgumentException.class,
                () -> controller.issue(nodeId, "timestamp", "nonce", "signature", body));
        verify(broker, never()).issue(any());
    }

    private byte[] request(UUID agentId, UUID projectId, long generation, String repositoryUrl) throws Exception {
        return mapper.writeValueAsString(new NodeGitCredentialController.CredentialRequest(
                        agentId, projectId, generation, repositoryUrl))
                .getBytes(StandardCharsets.UTF_8);
    }
}
