package com.agenticform.node;

import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.Comparator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.UUID;

@Service
public class ExecutionNodeScheduler {
    private static final List<AgentStatus> OCCUPYING = List.of(
            AgentStatus.STARTING, AgentStatus.IDLE, AgentStatus.WORKING,
            AgentStatus.WAITING_APPROVAL, AgentStatus.BLOCKED, AgentStatus.DISCONNECTED);

    private final ExecutionNodeRepository nodes;
    private final AgentRepository agents;
    private final ObjectMapper mapper;

    public ExecutionNodeScheduler(ExecutionNodeRepository nodes, AgentRepository agents, ObjectMapper mapper) {
        this.nodes = nodes;
        this.agents = agents;
        this.mapper = mapper;
    }

    public ExecutionNodeEntity select(UUID preferredNodeId, NodeTrustLevel minimumTrust,
                                      Set<String> requiredCapabilities) {
        return select(preferredNodeId, minimumTrust, requiredCapabilities, Set.of());
    }

    public ExecutionNodeEntity select(UUID preferredNodeId, NodeTrustLevel minimumTrust,
                                      Set<String> requiredCapabilities, Set<UUID> excludedNodeIds) {
        NodeTrustLevel trust = minimumTrust == null ? NodeTrustLevel.STANDARD : minimumTrust;
        Set<String> capabilities = requiredCapabilities == null ? Set.of("codex", "git") : requiredCapabilities;
        Set<UUID> excluded = excludedNodeIds == null ? Set.of() : excludedNodeIds;

        if (preferredNodeId != null) {
            if (excluded.contains(preferredNodeId)) throw new IllegalArgumentException("Preferred node is excluded from placement");
            ExecutionNodeEntity node = nodes.findById(preferredNodeId)
                    .orElseThrow(() -> new NoSuchElementException("Execution node not found: " + preferredNodeId));
            validate(node, trust, capabilities);
            return node;
        }

        return nodes.findAllByStatusOrderByName(ExecutionNodeStatus.ONLINE).stream()
                .filter(node -> !excluded.contains(node.getId()))
                .filter(node -> node.getTrustLevel().atLeast(trust))
                .filter(node -> supports(node, capabilities))
                .filter(node -> active(node) < node.getMaxAgents())
                .min(Comparator
                        .comparingDouble(this::loadRatio)
                        .thenComparing((ExecutionNodeEntity node) -> node.getDiskFreeMb() == null ? 0L : -node.getDiskFreeMb())
                        .thenComparing(ExecutionNodeEntity::getName))
                .orElseThrow(() -> new IllegalStateException("No eligible execution node is online with required capabilities and capacity"));
    }

    private void validate(ExecutionNodeEntity node, NodeTrustLevel trust, Set<String> capabilities) {
        if (node.getStatus() != ExecutionNodeStatus.ONLINE) throw new IllegalStateException("Execution node is not online: " + node.getName());
        if (!node.getTrustLevel().atLeast(trust)) throw new IllegalStateException("Execution node trust level is below requirement");
        if (!supports(node, capabilities)) throw new IllegalStateException("Execution node is missing required capabilities");
        if (active(node) >= node.getMaxAgents()) throw new IllegalStateException("Execution node has no free agent capacity");
    }

    private long active(ExecutionNodeEntity node) {
        return agents.countByExecutionNodeIdAndStatusIn(node.getId(), OCCUPYING);
    }

    private double loadRatio(ExecutionNodeEntity node) {
        return (double) active(node) / Math.max(1, node.getMaxAgents());
    }

    private boolean supports(ExecutionNodeEntity node, Set<String> required) {
        try {
            JsonNode capabilities = mapper.readTree(node.getCapabilitiesJson());
            for (String capability : required) {
                if (!capabilities.path(capability).asBoolean(false)) return false;
            }
            return true;
        } catch (Exception error) {
            return false;
        }
    }
}
