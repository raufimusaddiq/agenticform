package com.agenticform.message;

import com.agenticform.agent.AgentRepository;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.task.TaskWorkflowGate;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.*;

class AgentMessageServiceTest {
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

        AgentMessageService service = new AgentMessageService(messages, deliveries, agents, groups, memberships,
                rules, runtimes, nodes, workflowGate, mapper);
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
}
