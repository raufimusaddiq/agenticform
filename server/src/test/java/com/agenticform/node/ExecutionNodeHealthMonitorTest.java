package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.config.AgenticformProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ExecutionNodeHealthMonitorTest {
    @Mock ExecutionNodeRepository nodes;
    @Mock AgentRepository agents;
    @Mock ExecutionNodeEntity node;
    @Mock AgentEntity agent;

    @Test
    void staleDrainingNodeBecomesOfflineAndDisconnectsAgents() {
        AgenticformProperties properties = new AgenticformProperties();
        ExecutionNodeHealthMonitor monitor = new ExecutionNodeHealthMonitor(nodes, agents, properties);
        UUID nodeId = UUID.randomUUID();

        when(nodes.findAllByStatusInOrderByName(
                List.of(ExecutionNodeStatus.ONLINE, ExecutionNodeStatus.DRAINING)))
                .thenReturn(List.of(node));
        when(node.getLastSeenAt()).thenReturn(Instant.now().minusSeconds(120));
        when(node.getId()).thenReturn(nodeId);
        when(agents.findAllByExecutionNodeId(nodeId)).thenReturn(List.of(agent));
        when(agent.getStatus()).thenReturn(AgentStatus.IDLE);

        monitor.markStaleOffline();

        verify(node).setStatus(ExecutionNodeStatus.OFFLINE);
        verify(nodes).save(node);
        verify(agent).setStatus(AgentStatus.DISCONNECTED);
        verify(agents).save(agent);
    }
}
