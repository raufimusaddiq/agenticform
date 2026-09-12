package com.agenticform.node;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExecutionNodeDrainStateTest {
    @Test
    void drainingNodeReconnectsAsDrainingInsteadOfOnline() {
        ExecutionNodeEntity node = new ExecutionNodeEntity(
                "worker-1", NodeTrustLevel.STANDARD, "public-key", "fingerprint");
        node.setStatus(ExecutionNodeStatus.DRAINING);
        assertTrue(node.isDrainRequested());

        node.setStatus(ExecutionNodeStatus.OFFLINE);
        node.heartbeat("{}", "{}", 2, "linux", "amd64", "host", "1", "codex", 4, 8192L, 10000L);

        assertEquals(ExecutionNodeStatus.DRAINING, node.getStatus());
        assertTrue(node.isDrainRequested());
    }

    @Test
    void operatorReturningNodeOnlineClearsDrainIntent() {
        ExecutionNodeEntity node = new ExecutionNodeEntity(
                "worker-1", NodeTrustLevel.STANDARD, "public-key", "fingerprint");
        node.setStatus(ExecutionNodeStatus.DRAINING);
        node.setStatus(ExecutionNodeStatus.ONLINE);

        assertEquals(ExecutionNodeStatus.ONLINE, node.getStatus());
        assertFalse(node.isDrainRequested());
    }
}
