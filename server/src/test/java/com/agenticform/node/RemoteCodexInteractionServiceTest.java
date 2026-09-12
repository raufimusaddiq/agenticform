package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.codex.CodexServerRequestRouter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class RemoteCodexInteractionServiceTest {
    @Mock RemoteCodexInteractionRepository repository;
    @Mock AgentRepository agents;
    @Mock CodexServerRequestRouter router;
    @Mock RemoteInteractionContext context;
    @Mock AgentEntity agent;

    private RemoteCodexInteractionService service;
    private ObjectMapper mapper;

    @BeforeEach
    void setUp() {
        mapper = new ObjectMapper();
        service = new RemoteCodexInteractionService(repository, agents, router, context, mapper);
    }

    @Test
    void currentNodeAndGenerationOwnRemoteRequest() {
        UUID nodeId = UUID.randomUUID();
        ObjectNode params = mapper.createObjectNode().put("threadId", "thread-1");
        when(agents.findByCodexThreadId("thread-1")).thenReturn(Optional.of(agent));
        when(agent.ownsRuntime(nodeId, 4L)).thenReturn(true);

        assertSame(agent, service.requireRuntime(nodeId, 4L, params));
    }

    @Test
    void staleGenerationIsRejectedEvenWithKnownThread() {
        UUID nodeId = UUID.randomUUID();
        ObjectNode params = mapper.createObjectNode().put("threadId", "thread-1");
        when(agents.findByCodexThreadId("thread-1")).thenReturn(Optional.of(agent));
        when(agent.ownsRuntime(nodeId, 3L)).thenReturn(false);

        assertThrows(IllegalStateException.class,
                () -> service.requireRuntime(nodeId, 3L, params));
    }

    @Test
    void requestWithoutThreadIdentityIsRejected() {
        assertThrows(IllegalArgumentException.class,
                () -> service.requireRuntime(UUID.randomUUID(), 1L, mapper.createObjectNode()));
    }
}
