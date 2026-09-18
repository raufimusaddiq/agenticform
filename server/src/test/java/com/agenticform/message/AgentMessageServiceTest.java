package com.agenticform.message;

import com.agenticform.agent.AgentRepository;
import com.agenticform.event.ControlPlaneEventBus;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.task.TaskWorkflowGate;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.*;

class AgentMessageServiceTest {
    @Test
    void transientRuntimeFailureIsRetriedAfterRuntimeRecovers() {
        AgentMessageRepository messages = mock(AgentMessageRepository.class);
        AgentMessageDeliveryRepository deliveries = mock(AgentMessageDeliveryRepository.class);
        AgentRepository agents = mock(AgentRepository.class);
        AgentGroupRepository groups = mock(AgentGroupRepository.class);
        AgentGroupMembershipRepository memberships = mock(AgentGroupMembershipRepository.class);
        CommunicationRuleService rules = mock(CommunicationRuleService.class);
        AgentRuntimeRegistry runtimes = mock(AgentRuntimeRegistry.class);
        ExecutionNodeService nodes = mock(ExecutionNodeService.class);
        TaskWorkflowGate workflowGate = mock(TaskWorkflowGate.class);
        ObjectMapper mapper = mock(ObjectMapper.class);
        ControlPlaneEventBus events = mock(ControlPlaneEventBus.class);
        AgentMessageService service = new AgentMessageService(messages, deliveries, agents, groups, memberships,
                rules, runtimes, nodes, workflowGate, mapper, events);

        UUID messageId = UUID.randomUUID();
        UUID from = UUID.randomUUID();
        UUID to = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        AgentMessageDeliveryEntity delivery = new AgentMessageDeliveryEntity(messageId, to);
        delivery.markFailed("Target remote runtime is not ready");
        AgentMessageEntity message = mock(AgentMessageEntity.class);
        when(message.getFromAgentId()).thenReturn(from);
        when(message.getId()).thenReturn(messageId);
        when(message.getConversationId()).thenReturn(UUID.randomUUID());
        when(message.getAudienceType()).thenReturn(AgentMessageAudienceType.DIRECT);
        when(message.getType()).thenReturn(AgentMessageType.INFORMATION);
        when(message.getSubject()).thenReturn("subject");
        when(message.getContent()).thenReturn("content");
        when(message.getHopCount()).thenReturn(0);
        com.agenticform.agent.AgentEntity sourceAgent = mock(com.agenticform.agent.AgentEntity.class);
        UUID sharedProjectId = UUID.randomUUID();
        when(sourceAgent.getProjectId()).thenReturn(sharedProjectId);
        when(sourceAgent.getId()).thenReturn(from);
        when(sourceAgent.getName()).thenReturn("source");
        com.agenticform.agent.AgentEntity targetAgent = mock(com.agenticform.agent.AgentEntity.class);
        when(targetAgent.getName()).thenReturn("target");
        when(targetAgent.getStatus()).thenReturn(com.agenticform.agent.AgentStatus.IDLE);
        when(targetAgent.getRuntimeSessionId()).thenReturn("thread-recovered");
        when(targetAgent.getRuntimeGeneration()).thenReturn(7L);
        when(targetAgent.getExecutionNodeId()).thenReturn(nodeId);
        when(targetAgent.getId()).thenReturn(to);
        when(targetAgent.getProjectId()).thenReturn(sharedProjectId);
        when(targetAgent.getRuntimeType()).thenReturn(com.agenticform.runtime.RuntimeType.CODEX);
        when(agents.findById(to)).thenReturn(Optional.of(targetAgent));
        when(agents.findById(from)).thenReturn(Optional.of(sourceAgent));
        when(deliveries.findAllByStatus(AgentMessageStatus.FAILED)).thenReturn(List.of(delivery));
        when(deliveries.findAllByMessageIdOrderByCreatedAtAsc(messageId)).thenReturn(List.of(delivery));
        when(messages.findById(messageId)).thenReturn(Optional.of(message));
        com.agenticform.node.NodeCommandEntity command = mock(com.agenticform.node.NodeCommandEntity.class);
        when(command.getId()).thenReturn(UUID.randomUUID());
        when(nodes.enqueue(any(), any(), any(), any(), any())).thenReturn(command);

        service.reconcileStaleDeliveries();

        assertTrue(delivery.getAttemptCount() >= 1);
        verify(nodes).enqueue(eq(nodeId), eq(to), eq("DELIVER_MESSAGE"), anyString(), any());
    }

    @Test
    void inboxAcknowledgementRefreshesMessageAggregate() {
        AgentMessageRepository messages = mock(AgentMessageRepository.class);
        AgentMessageDeliveryRepository deliveries = mock(AgentMessageDeliveryRepository.class);
        AgentRepository agents = mock(AgentRepository.class);
        AgentGroupRepository groups = mock(AgentGroupRepository.class);
        AgentGroupMembershipRepository memberships = mock(AgentGroupMembershipRepository.class);
        CommunicationRuleService rules = mock(CommunicationRuleService.class);
        AgentRuntimeRegistry runtimes = mock(AgentRuntimeRegistry.class);
        ExecutionNodeService nodes = mock(ExecutionNodeService.class);
        TaskWorkflowGate workflowGate = mock(TaskWorkflowGate.class);
        ObjectMapper mapper = mock(ObjectMapper.class);
        ControlPlaneEventBus events = mock(ControlPlaneEventBus.class);

        AgentMessageService service = new AgentMessageService(messages, deliveries, agents, groups, memberships,
                rules, runtimes, nodes, workflowGate, mapper, events);
        UUID agentId = UUID.randomUUID();
        UUID messageId = UUID.randomUUID();
        AgentMessageDeliveryEntity delivery = new AgentMessageDeliveryEntity(messageId, agentId);
        AgentMessageEntity message = mock(AgentMessageEntity.class);
        when(deliveries.findAllByToAgentIdOrderByCreatedAtDesc(agentId)).thenReturn(List.of(delivery));
        when(messages.findById(messageId)).thenReturn(java.util.Optional.of(message));
        when(message.getId()).thenReturn(messageId);
        when(deliveries.findAllByMessageIdOrderByCreatedAtAsc(messageId)).thenReturn(List.of(delivery));

        List<AgentMessageService.InboxItem> result = service.inbox(agentId, true);

        assertEquals(1, result.size());
        verify(deliveries).save(delivery);
        verify(messages).save(message);
        verify(message).markCompleted();
    }

    @Test
    void transientRetryPublishesMessageUpdateForSseRefresh() {
        AgentMessageRepository messages = mock(AgentMessageRepository.class);
        AgentMessageDeliveryRepository deliveries = mock(AgentMessageDeliveryRepository.class);
        AgentRepository agents = mock(AgentRepository.class);
        AgentGroupRepository groups = mock(AgentGroupRepository.class);
        AgentGroupMembershipRepository memberships = mock(AgentGroupMembershipRepository.class);
        CommunicationRuleService rules = mock(CommunicationRuleService.class);
        AgentRuntimeRegistry runtimes = mock(AgentRuntimeRegistry.class);
        ExecutionNodeService nodes = mock(ExecutionNodeService.class);
        TaskWorkflowGate workflowGate = mock(TaskWorkflowGate.class);
        ObjectMapper mapper = mock(ObjectMapper.class);
        ControlPlaneEventBus events = mock(ControlPlaneEventBus.class);
        AgentMessageService service = new AgentMessageService(messages, deliveries, agents, groups, memberships,
                rules, runtimes, nodes, workflowGate, mapper, events);

        UUID messageId = UUID.randomUUID();
        UUID from = UUID.randomUUID();
        UUID to = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        AgentMessageDeliveryEntity delivery = new AgentMessageDeliveryEntity(messageId, to);
        delivery.markFailed("Target remote runtime is not ready");
        AgentMessageEntity message = mock(AgentMessageEntity.class);
        when(message.getFromAgentId()).thenReturn(from);
        when(message.getId()).thenReturn(messageId);
        when(message.getConversationId()).thenReturn(UUID.randomUUID());
        when(message.getProjectId()).thenReturn(projectId);
        when(message.getAudienceType()).thenReturn(AgentMessageAudienceType.DIRECT);
        when(message.getType()).thenReturn(AgentMessageType.INFORMATION);
        when(message.getSubject()).thenReturn("subject");
        when(message.getContent()).thenReturn("content");
        when(message.getHopCount()).thenReturn(0);
        com.agenticform.agent.AgentEntity sourceAgent = mock(com.agenticform.agent.AgentEntity.class);
        when(sourceAgent.getProjectId()).thenReturn(projectId);
        when(sourceAgent.getId()).thenReturn(from);
        when(sourceAgent.getName()).thenReturn("source");
        com.agenticform.agent.AgentEntity targetAgent = mock(com.agenticform.agent.AgentEntity.class);
        when(targetAgent.getName()).thenReturn("target");
        when(targetAgent.getStatus()).thenReturn(com.agenticform.agent.AgentStatus.IDLE);
        when(targetAgent.getRuntimeSessionId()).thenReturn("thread-recovered");
        when(targetAgent.getRuntimeGeneration()).thenReturn(7L);
        when(targetAgent.getExecutionNodeId()).thenReturn(nodeId);
        when(targetAgent.getId()).thenReturn(to);
        when(targetAgent.getProjectId()).thenReturn(projectId);
        when(targetAgent.getRuntimeType()).thenReturn(com.agenticform.runtime.RuntimeType.CODEX);
        when(agents.findById(to)).thenReturn(Optional.of(targetAgent));
        when(agents.findById(from)).thenReturn(Optional.of(sourceAgent));
        when(deliveries.findAllByStatus(AgentMessageStatus.FAILED)).thenReturn(List.of(delivery));
        when(deliveries.findAllByMessageIdOrderByCreatedAtAsc(messageId)).thenReturn(List.of(delivery));
        when(messages.findById(messageId)).thenReturn(Optional.of(message));
        com.agenticform.node.NodeCommandEntity command = mock(com.agenticform.node.NodeCommandEntity.class);
        when(command.getId()).thenReturn(UUID.randomUUID());
        when(nodes.enqueue(any(), any(), any(), any(), any())).thenReturn(command);

        service.reconcileStaleDeliveries();

        verify(events, atLeastOnce()).publish(eq("message.updated"), eq(projectId), eq(messageId));
    }
}
