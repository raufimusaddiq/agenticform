package com.agenticform.agent;

import com.agenticform.config.AgenticformProperties;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.node.ExecutionNodeStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;

@Service
public class AgentRuntimeRecoveryScheduler {
    private final AgentRepository agents;
    private final ExecutionNodeService nodes;
    private final AgentRuntimeRecoveryService recovery;
    private final AgenticformProperties properties;

    public AgentRuntimeRecoveryScheduler(AgentRepository agents,
                                         ExecutionNodeService nodes,
                                         AgentRuntimeRecoveryService recovery,
                                         AgenticformProperties properties) {
        this.agents = agents;
        this.nodes = nodes;
        this.recovery = recovery;
        this.properties = properties;
    }

    @Scheduled(fixedDelayString = "${agenticform.node.recovery-delay-ms:30000}")
    public void recoverLostRuntimes() {
        if (!properties.getNode().isAutoRecoveryEnabled()) return;
        Instant cutoff = Instant.now().minus(properties.getNode().getRecoveryGrace());
        for (AgentEntity agent : agents.findAll()) {
            if (agent.getExecutionNodeId() == null || agent.getStatus() != AgentStatus.DISCONNECTED) continue;
            if (agent.getUpdatedAt() == null || agent.getUpdatedAt().isAfter(cutoff)) continue;
            try {
                if (nodes.get(agent.getExecutionNodeId()).getStatus() != ExecutionNodeStatus.OFFLINE) continue;
                recovery.recover(agent.getId());
            } catch (RuntimeException ignored) {
                // Fail closed. Manual recovery remains available when placement, approval, or source constraints block automation.
            }
        }
    }
}
