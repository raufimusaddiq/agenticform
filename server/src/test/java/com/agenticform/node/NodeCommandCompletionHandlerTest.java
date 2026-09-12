package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.message.AgentMessageDeliveryRepository;
import com.agenticform.task.TaskRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.util.Optional;
import java.util.UUID;

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
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.ownsRuntime(nodeId, 2L)).thenReturn(true);

        handler.handle(command, true, "{\"cleaned\":true}", null);

        verify(agent).setStatus(AgentStatus.STOPPED);
        verify(agent).setActiveTaskId(null);
        verify(agent).setActiveTurnId(null);
        verify(agents).save(agent);
    }
}
