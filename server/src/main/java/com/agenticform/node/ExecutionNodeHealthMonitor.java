package com.agenticform.node;

import com.agenticform.config.AgenticformProperties;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Service
public class ExecutionNodeHealthMonitor {
    private final ExecutionNodeRepository nodes;
    private final AgenticformProperties properties;

    public ExecutionNodeHealthMonitor(ExecutionNodeRepository nodes, AgenticformProperties properties) {
        this.nodes = nodes;
        this.properties = properties;
    }

    @Scheduled(fixedDelayString = "${agenticform.node.health-delay-ms:15000}")
    @Transactional
    public void markStaleOffline() {
        Instant cutoff = Instant.now().minus(properties.getNode().getOfflineAfter());
        for (ExecutionNodeEntity node : nodes.findAllByStatusOrderByName(ExecutionNodeStatus.ONLINE)) {
            if (node.getLastSeenAt() != null && node.getLastSeenAt().isBefore(cutoff)) {
                node.setStatus(ExecutionNodeStatus.OFFLINE);
                nodes.save(node);
            }
        }
    }
}
