package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.config.AgenticformProperties;
import com.agenticform.operation.OperationalSeverity;
import com.agenticform.operation.OperationalSignalService;
import com.agenticform.operation.OperationalSignalSource;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;

@Service
public class ExecutionNodeHealthMonitor {
    private final ExecutionNodeRepository nodes;
    private final AgentRepository agents;
    private final AgenticformProperties properties;
    private final OperationalSignalService signals;

    public ExecutionNodeHealthMonitor(ExecutionNodeRepository nodes,
                                      AgentRepository agents,
                                      AgenticformProperties properties,
                                      OperationalSignalService signals) {
        this.nodes = nodes;
        this.agents = agents;
        this.properties = properties;
        this.signals = signals;
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
            List<AgentEntity> active = agents.findAllByExecutionNodeId(node.getId()).stream()
                    .filter(agent -> agent.getStatus() != AgentStatus.STOPPED && agent.getStatus() != AgentStatus.FAILED)
                    .toList();
            active.forEach(agent -> {
                agent.setStatus(AgentStatus.DISCONNECTED);
                agents.save(agent);
            });
            active.stream().map(AgentEntity::getProjectId).distinct().forEach(projectId -> {
                long count = active.stream().filter(agent -> projectId.equals(agent.getProjectId())).count();
                signals.record(new OperationalSignalService.SignalInput(
                        projectId, OperationalSignalSource.NODE_HEALTH,
                        "EXECUTION_NODE_OFFLINE_ACTIVE", OperationalSeverity.HIGH,
                        "node:" + node.getId() + ":offline-active",
                        "node:" + node.getId(),
                        Map.of(
                                "nodeId", node.getId().toString(),
                                "nodeName", node.getName(),
                                "activeAgentCount", count,
                                "lastSeenAt", node.getLastSeenAt() == null ? "" : node.getLastSeenAt().toString()),
                        Instant.now()));
            });
        }
    }
}
