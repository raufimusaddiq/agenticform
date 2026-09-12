package com.agenticform.node;

import com.agenticform.agent.AgentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ExecutionNodeSchedulerTest {
    @Mock ExecutionNodeRepository nodes;
    @Mock AgentRepository agents;

    private ExecutionNodeScheduler scheduler;

    @BeforeEach
    void setUp() {
        scheduler = new ExecutionNodeScheduler(nodes, agents, new ObjectMapper());
    }

    @Test
    void preferredNodeMustMeetTrustCapabilityAndCapacity() {
        UUID id = UUID.randomUUID();
        ExecutionNodeEntity node = node(id, "worker", NodeTrustLevel.STANDARD,
                "{\"codex\":true,\"git\":true}", 2, 1000L);
        when(nodes.findById(id)).thenReturn(Optional.of(node));
        when(agents.countByExecutionNodeIdAndStatusIn(id, anyList())).thenReturn(0L);

        assertThrows(IllegalStateException.class,
                () -> scheduler.select(id, NodeTrustLevel.TRUSTED, Set.of("codex", "git")));
    }

    @Test
    void preferredNodeMissingCapabilityIsRejected() {
        UUID id = UUID.randomUUID();
        ExecutionNodeEntity node = node(id, "worker", NodeTrustLevel.TRUSTED,
                "{\"codex\":true,\"git\":false}", 2, 1000L);
        when(nodes.findById(id)).thenReturn(Optional.of(node));

        assertThrows(IllegalStateException.class,
                () -> scheduler.select(id, NodeTrustLevel.STANDARD, Set.of("codex", "git")));
    }

    @Test
    void fullNodeIsRejected() {
        UUID id = UUID.randomUUID();
        ExecutionNodeEntity node = node(id, "worker", NodeTrustLevel.TRUSTED,
                "{\"codex\":true,\"git\":true}", 1, 1000L);
        when(nodes.findById(id)).thenReturn(Optional.of(node));
        when(agents.countByExecutionNodeIdAndStatusIn(id, anyList())).thenReturn(1L);

        assertThrows(IllegalStateException.class,
                () -> scheduler.select(id, NodeTrustLevel.STANDARD, Set.of("codex", "git")));
    }

    @Test
    void automaticPlacementChoosesEligibleLowerLoadNode() {
        UUID busyId = UUID.randomUUID();
        UUID freeId = UUID.randomUUID();
        ExecutionNodeEntity busy = node(busyId, "busy", NodeTrustLevel.TRUSTED,
                "{\"codex\":true,\"git\":true}", 4, 5000L);
        ExecutionNodeEntity free = node(freeId, "free", NodeTrustLevel.TRUSTED,
                "{\"codex\":true,\"git\":true}", 4, 1000L);
        when(nodes.findAllByStatusOrderByName(ExecutionNodeStatus.ONLINE)).thenReturn(List.of(busy, free));
        when(agents.countByExecutionNodeIdAndStatusIn(busyId, anyList())).thenReturn(3L);
        when(agents.countByExecutionNodeIdAndStatusIn(freeId, anyList())).thenReturn(1L);

        assertEquals(freeId, scheduler.select(null, NodeTrustLevel.STANDARD, Set.of("codex", "git")).getId());
    }

    private ExecutionNodeEntity node(UUID id, String name, NodeTrustLevel trust, String capabilities,
                                     int maxAgents, long diskFreeMb) {
        ExecutionNodeEntity node = mock(ExecutionNodeEntity.class);
        when(node.getId()).thenReturn(id);
        when(node.getName()).thenReturn(name);
        when(node.getStatus()).thenReturn(ExecutionNodeStatus.ONLINE);
        when(node.getTrustLevel()).thenReturn(trust);
        when(node.getCapabilitiesJson()).thenReturn(capabilities);
        when(node.getMaxAgents()).thenReturn(maxAgents);
        when(node.getDiskFreeMb()).thenReturn(diskFreeMb);
        return node;
    }
}
