package com.agenticform.agent;

import com.agenticform.config.AgenticformProperties;
import com.agenticform.operation.OperationalSeverity;
import com.agenticform.operation.OperationalSignalService;
import com.agenticform.operation.OperationalSignalSource;
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
    private final OperationalSignalService signals;

    public AgentRuntimeRecoveryScheduler(AgentRepository agents,
                                         ExecutionNodeService nodes,
                                         AgentRuntimeRecoveryService recovery,
                                         AgenticformProperties properties,
                                         OperationalSignalService signals) {
        this.agents = agents;
        this.nodes = nodes;
        this.recovery = recovery;
        this.properties = properties;
        this.signals = signals;
    }

    @Scheduled(fixedDelayString = "${agenticform.node.recovery-delay-ms:30000}")
    public void recoverLostRuntimes() {
        if (!properties.getNode().isAutoRecoveryEnabled()) return;
        Instant cutoff = Instant.now().minus(properties.getNode().getRecoveryGrace());
        for (AgentEntity agent : agents.findAll()) {
            if (agent.getExecutionNodeId() == null || agent.getStatus() != AgentStatus.DISCONNECTED) continue;
            try {
                ExecutionNodeStatus nodeStatus = nodes.get(agent.getExecutionNodeId()).getStatus();
                if (nodeStatus != ExecutionNodeStatus.OFFLINE && nodeStatus != ExecutionNodeStatus.ONLINE) continue;
                if (nodeStatus == ExecutionNodeStatus.OFFLINE
                        && (agent.getUpdatedAt() == null || agent.getUpdatedAt().isAfter(cutoff))) continue;
                recovery.recover(agent.getId());
                // One bounded episode per recovery; repeated transport failures
                // converge on the existing signal fingerprint instead of unbounded restarts.
                signals.record(new com.agenticform.operation.OperationalSignalService.SignalInput(
                        agent.getProjectId(), OperationalSignalSource.NODE_HEALTH,
                        "AGENT_RUNTIME_RECOVERED", OperationalSeverity.INFO,
                        "agent:" + agent.getId() + ":recovered:g" + agent.getRuntimeGeneration(),
                        "agent:" + agent.getId(),
                        java.util.Map.of(
                                "agentId", agent.getId().toString(),
                                "runtimeGeneration", agent.getRuntimeGeneration(),
                                "executionNodeId", String.valueOf(agent.getExecutionNodeId())),
                        java.time.Instant.now()));
            } catch (RuntimeException ignored) {
                // Fail closed. Manual recovery remains available when placement, approval, or source constraints block automation.
            }
        }
    }
}
