package com.agenticform.node;

import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.config.AgenticformProperties;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

@Service
public class ExecutionNodeHealthMonitor {
    private final ExecutionNodeRepository nodes;
    private final AgentRepository agents;
    private final AgenticformProperties properties;

    public ExecutionNodeHealthMonitor(ExecutionNodeRepository nodes,
                                      AgentRepository agents,
                                      AgenticformProperties properties) {
        this.nodes = nodes;
        this.agents = agents;
        this.properties = properties;
    }

    @Scheduled(fixedDelayString = "${agenticform.node.health-delay-ms:15000}")
    @Transactional
    public void markStaleOffline() {
        Instant cutoff = Instant.now().minus(properties.getNode().getOfflineAfter());
        for (ExecutionNodeEntity node : nodes.findAllByStatusInOrderByName(
                List.of(ExecutionNodeStatus.ONLINE, ExecutionNodeStatus.DRAINING))) {
            if (node.getLastSeenAt() == null || !node.getLastSeenAt().isBefore(cutoff)) continue;
            node.setStatus(ExecutionNodeStatus.OFFLINE);
            nodes.save(node);
            agents.findAllByExecutionNodeId(node.getId()).forEach(agent -> {
                if (agent.getStatus() != AgentStatus.STOPPED && agent.getStatus() != AgentStatus.FAILED) {
                    agent.setStatus(AgentStatus.DISCONNECTED);
                    agents.save(agent);
                }
            });
        }
    }
}
