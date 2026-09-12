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
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class OperationalIncidentWakeServiceTest {
    @Mock OperationalIncidentRepository incidents;
    @Mock AgentRepository agents;
    @Mock CodexGateway codexGateway;
    @Mock ExecutionNodeService nodeService;
    @Mock NodeCommandRepository commands;

    OperationalIncidentWakeService service;

    @BeforeEach
    void setUp() {
        service = new OperationalIncidentWakeService(
                incidents, agents, codexGateway, nodeService, commands, new ObjectMapper());
    }

    @Test
    void remoteOperationalAgentIsWokenThroughGenerationFencedNodeCommand() {
        UUID incidentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        UUID commandId = UUID.randomUUID();

        OperationalIncidentEntity incident = incident(incidentId, projectId, OperationalIncidentEntity.WakeStatus.PENDING);
        when(incidents.findTop50ByWakeStatusInOrderByUpdatedAtAsc(any())).thenReturn(List.of(incident));

        AgentEntity agent = mock(AgentEntity.class);
        when(agent.getId()).thenReturn(agentId);
        when(agent.getStatus()).thenReturn(AgentStatus.IDLE);
        when(agent.getCodexThreadId()).thenReturn("thread-1");
        when(agent.getExecutionNodeId()).thenReturn(nodeId);
        when(agent.getRuntimeGeneration()).thenReturn(4L);
        when(agents.findByProjectIdAndRole(projectId, AgentRole.OPERATIONAL)).thenReturn(Optional.of(agent));

        NodeCommandEntity command = mock(NodeCommandEntity.class);
        when(command.getId()).thenReturn(commandId);
        when(command.terminal()).thenReturn(false);
        when(nodeService.enqueue(eq(nodeId), eq(agentId), eq("DELIVER_MESSAGE"),
                eq("agenticform-incident:" + incidentId + ":g4:attempt:1"), any(Map.class))).thenReturn(command);

        service.deliverPending();

        verify(incident).setOperationalAgentId(agentId);
        verify(incident).queued(commandId);
        verify(incidents).save(incident);
    }

    @Test
    void queuedRemoteWakeReconcilesTerminalCommandResultWithoutRedelivery() {
        UUID incidentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        UUID commandId = UUID.randomUUID();
        OperationalIncidentEntity incident = incident(incidentId, projectId, OperationalIncidentEntity.WakeStatus.QUEUED);
        when(incident.getWakeCommandId()).thenReturn(commandId);
        when(incidents.findTop50ByWakeStatusInOrderByUpdatedAtAsc(any())).thenReturn(List.of(incident));
        when(incidents.findById(incidentId)).thenReturn(Optional.of(incident));

        NodeCommandEntity command = mock(NodeCommandEntity.class);
        when(command.terminal()).thenReturn(true);
        when(command.getStatus()).thenReturn(NodeCommandEntity.Status.SUCCEEDED);
        when(command.getPayloadJson()).thenReturn("{\"incidentId\":\"" + incidentId + "\"}");
        when(command.getResultJson()).thenReturn("{\"queuedSubmissionId\":\"queue-1\",\"turnId\":\"turn-1\"}");
        when(commands.findById(commandId)).thenReturn(Optional.of(command));

        service.deliverPending();

        verify(incident).delivered("queue-1", "turn-1");
        verify(incidents).save(incident);
    }

    private OperationalIncidentEntity incident(UUID id, UUID projectId, OperationalIncidentEntity.WakeStatus wakeStatus) {
        OperationalIncidentEntity incident = mock(OperationalIncidentEntity.class);
        lenient().when(incident.getId()).thenReturn(id);
        lenient().when(incident.getProjectId()).thenReturn(projectId);
        lenient().when(incident.getWakeStatus()).thenReturn(wakeStatus);
        lenient().when(incident.getWakeAttempts()).thenReturn(wakeStatus == OperationalIncidentEntity.WakeStatus.PENDING ? 0 : 1);
        lenient().when(incident.terminal()).thenReturn(false);
        lenient().when(incident.getIncidentType()).thenReturn("SERVICE_DEGRADED");
        lenient().when(incident.getSeverity()).thenReturn(OperationalSeverity.HIGH);
        lenient().when(incident.getStatus()).thenReturn(OperationalIncidentEntity.Status.OPEN);
        lenient().when(incident.getSummary()).thenReturn("service degraded");
        return incident;
    }
}
