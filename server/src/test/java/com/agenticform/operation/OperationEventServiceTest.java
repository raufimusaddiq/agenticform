package com.agenticform.operation;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.agent.AgentStatus;
import com.agenticform.codex.CodexGateway;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.node.NodeCommandEntity;
import com.agenticform.node.NodeCommandRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class OperationEventServiceTest {
    @Mock OperationEventRepository events;
    @Mock AgentRepository agents;
    @Mock CodexGateway codexGateway;
    @Mock OperationalSignalService signals;
    @Mock ExecutionNodeService nodeService;
    @Mock NodeCommandRepository commands;

    OperationEventService service;

    @BeforeEach
    void setUp() {
        service = new OperationEventService(events, agents, codexGateway, signals,
                nodeService, commands, new ObjectMapper());
    }

    @Test
    void remoteOperationalAgentReceivesTerminalEventThroughNodeFabric() {
        UUID eventId = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        UUID commandId = UUID.randomUUID();

        OperationEventEntity event = mock(OperationEventEntity.class);
        when(event.getId()).thenReturn(eventId);
        when(event.getOperationRunId()).thenReturn(runId);
        when(event.getTargetAgentId()).thenReturn(agentId);
        when(event.getEventType()).thenReturn("OPERATION_FAILED");
        when(event.getPayload()).thenReturn("failed deploy");
        when(event.getStatus()).thenReturn(OperationEventEntity.Status.PENDING);
        when(event.getAttempts()).thenReturn(0);
        when(events.findTop50ByStatusInOrderByCreatedAtAsc(any())).thenReturn(List.of(event));

        AgentEntity agent = mock(AgentEntity.class);
        when(agent.getId()).thenReturn(agentId);
        when(agent.getRole()).thenReturn(AgentRole.OPERATIONAL);
        when(agent.getStatus()).thenReturn(AgentStatus.IDLE);
        when(agent.getCodexThreadId()).thenReturn("thread-ops");
        when(agent.getExecutionNodeId()).thenReturn(nodeId);
        when(agent.getRuntimeGeneration()).thenReturn(3L);
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));

        NodeCommandEntity command = mock(NodeCommandEntity.class);
        when(command.getId()).thenReturn(commandId);
        when(command.terminal()).thenReturn(false);
        when(nodeService.enqueue(eq(nodeId), eq(agentId), eq("DELIVER_MESSAGE"),
                eq("agenticform-operation-event:" + eventId + ":g3"), any(Map.class))).thenReturn(command);

        service.deliverPending();

        verify(event).queued(commandId);
        verify(events).save(event);
    }

    @Test
    void queuedRemoteOperationEventReconcilesTerminalCommand() {
        UUID commandId = UUID.randomUUID();
        OperationEventEntity event = mock(OperationEventEntity.class);
        when(event.getStatus()).thenReturn(OperationEventEntity.Status.QUEUED);
        when(event.getAttempts()).thenReturn(1);
        when(event.queuedNodeCommandId()).thenReturn(commandId);
        when(events.findTop50ByStatusInOrderByCreatedAtAsc(any())).thenReturn(List.of(event));

        NodeCommandEntity command = mock(NodeCommandEntity.class);
        when(command.terminal()).thenReturn(true);
        when(command.getStatus()).thenReturn(NodeCommandEntity.Status.SUCCEEDED);
        when(command.getResultJson()).thenReturn("{\"queuedSubmissionId\":\"queue-2\",\"turnId\":\"turn-2\"}");
        when(commands.findById(commandId)).thenReturn(Optional.of(command));

        service.deliverPending();

        verify(event).delivered("queue-2", "turn-2");
        verify(events).save(event);
    }
}
