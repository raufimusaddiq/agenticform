package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.message.AgentMessageDeliveryRepository;
import com.agenticform.task.TaskRepository;
import com.agenticform.runtime.RuntimeType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.util.Optional;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class NodeCommandCompletionHandlerTest {
    @Mock AgentRepository agents;
    @Mock TaskRepository tasks;
    @Mock AgentMessageDeliveryRepository deliveries;
    @Mock ExecutionNodeService nodes;
    @Mock NodeCommandEntity command;
    @Mock AgentEntity agent;

    private NodeCommandCompletionHandler handler;

    @BeforeEach
    void setUp() {
        handler = new NodeCommandCompletionHandler(agents, tasks, deliveries, nodes, new ObjectMapper());
    }

    @Test
    void cleanupRefusalReturnsAgentToIdleInsteadOfDisconnected() {
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        when(command.getCommandType()).thenReturn("CLEANUP_WORKSPACE");
        when(command.getAgentId()).thenReturn(agentId);
        when(command.getNodeId()).thenReturn(nodeId);
        when(command.getRuntimeGeneration()).thenReturn(4L);
        when(command.getPayloadJson()).thenReturn("{}");
        when(command.getIdempotencyKey()).thenReturn("cleanup-runtime:" + agentId + ":g4");
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.ownsRuntime(nodeId, 4L)).thenReturn(true);

        handler.handle(command, false, null, "worktree is dirty; cleanup refused");

        verify(agent).setStatus(AgentStatus.IDLE);
        verify(agents).save(agent);
    }

    @Test
    void successfulCleanupStopsCurrentRuntime() {
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        when(command.getCommandType()).thenReturn("CLEANUP_WORKSPACE");
        when(command.getAgentId()).thenReturn(agentId);
        when(command.getNodeId()).thenReturn(nodeId);
        when(command.getRuntimeGeneration()).thenReturn(2L);
        when(command.getPayloadJson()).thenReturn("{}");
        when(command.getIdempotencyKey()).thenReturn("cleanup-runtime:" + agentId + ":g2");
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.ownsRuntime(nodeId, 2L)).thenReturn(true);

        handler.handle(command, true, "{\"cleaned\":true}", null);

        verify(agent).setStatus(AgentStatus.STOPPED);
        verify(agent).setActiveTaskId(null);
        verify(agent).setActiveTurnId(null);
        verify(agents).save(agent);
    }

    @Test
    void successfulStopInterruptQueuesCleanupAfterInterrupt() {
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        when(command.getCommandType()).thenReturn("INTERRUPT_TURN");
        when(command.getAgentId()).thenReturn(agentId);
        when(command.getNodeId()).thenReturn(nodeId);
        when(command.getRuntimeGeneration()).thenReturn(7L);
        when(command.getPayloadJson()).thenReturn("{\"stopLifecycle\":true,\"cleanupAfterInterrupt\":true,\"defaultBranch\":\"main\"}");
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getId()).thenReturn(agentId);
        when(agent.getRuntimeSessionId()).thenReturn("session-7");
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.ownsRuntime(nodeId, 7L)).thenReturn(true);

        handler.handle(command, true, "{\"interrupted\":true}", null);

        verify(nodes).enqueue(eq(nodeId), eq(agentId), eq("CLEANUP_WORKSPACE"),
                eq("stop-cleanup:" + agentId + ":g7"), anyMap());
        verify(agent, never()).setStatus(AgentStatus.STOPPED);
    }

    @Test
    void failedStopInterruptDoesNotQueueCleanup() {
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        when(command.getCommandType()).thenReturn("INTERRUPT_TURN");
        when(command.getAgentId()).thenReturn(agentId);
        when(command.getNodeId()).thenReturn(nodeId);
        when(command.getRuntimeGeneration()).thenReturn(7L);
        when(command.getPayloadJson()).thenReturn("{\"stopLifecycle\":true,\"cleanupAfterInterrupt\":true}");
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.ownsRuntime(nodeId, 7L)).thenReturn(true);

        handler.handle(command, false, null, "interrupt failed");

        verify(agent).setStatus(AgentStatus.DISCONNECTED);
        verify(nodes, never()).enqueue(eq(nodeId), eq(agentId), eq("CLEANUP_WORKSPACE"),
                eq("stop-cleanup:" + agentId + ":g7"), anyMap());
    }

    @Test
    void stopCleanupRefusalStillFinalizesStopAndRetainsWorkspace() {
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        when(command.getCommandType()).thenReturn("CLEANUP_WORKSPACE");
        when(command.getAgentId()).thenReturn(agentId);
        when(command.getNodeId()).thenReturn(nodeId);
        when(command.getRuntimeGeneration()).thenReturn(9L);
        when(command.getPayloadJson()).thenReturn("{\"stopLifecycle\":true}");
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.ownsRuntime(nodeId, 9L)).thenReturn(true);

        handler.handle(command, false, null, "worktree branch is not proven merged");

        verify(agent).setStatus(AgentStatus.STOPPED);
        verify(agent).setActiveTaskId(null);
        verify(agent).setActiveTurnId(null);
        verify(agents).save(agent);
    }
}
