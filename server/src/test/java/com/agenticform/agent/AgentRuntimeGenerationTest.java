package com.agenticform.agent;

import com.agenticform.workspace.WorkspaceMode;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentRuntimeGenerationTest {
    @Test
    void movingRuntimeIncrementsGenerationAndFencesOldRuntime() {
        UUID projectId = UUID.randomUUID();
        UUID nodeA = UUID.randomUUID();
        UUID nodeB = UUID.randomUUID();
        AgentEntity agent = new AgentEntity(
                projectId, "coder", "code", null,
                WorkspaceMode.ISOLATED_WORKTREE, null, null, "agent/coder",
                AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP,
                AgentRole.GENERAL, false, nodeA);

        assertEquals(1L, agent.getRuntimeGeneration());
        assertTrue(agent.ownsRuntime(nodeA, 1));

        long generation = agent.reassignRuntime(nodeB, "recovery/coder-g2");

        assertEquals(2L, generation);
        assertFalse(agent.ownsRuntime(nodeA, 1));
        assertTrue(agent.ownsRuntime(nodeB, 2));
        assertEquals(AgentStatus.STARTING, agent.getStatus());
        assertThrows(IllegalStateException.class,
                () -> agent.bindRuntime(1, "stale-thread", "/src", "/work", "old"));

        agent.bindRuntime(2, "thread-2", "/src", "/work", "recovery/coder-g2");
        assertEquals("thread-2", agent.getCodexThreadId());
        assertEquals(AgentStatus.IDLE, agent.getStatus());
    }

    @Test
    void staleSnapshotCannotOverwriteCurrentRuntime() {
        UUID node = UUID.randomUUID();
        AgentEntity agent = new AgentEntity(
                UUID.randomUUID(), "coder", "code", null,
                WorkspaceMode.ISOLATED_WORKTREE, null, null, "agent/coder",
                AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP,
                AgentRole.GENERAL, false, node);
        agent.bindRuntime(1, "thread-1", "/src-1", "/work-1", "branch-1");
        agent.reassignRuntime(node, "branch-2");
        agent.bindRuntime(2, "thread-2", "/src-2", "/work-2", "branch-2");

        agent.recoverFromSnapshot(1, "stale-thread", "/stale-src", "/stale-work", "stale-branch");

        assertEquals("thread-2", agent.getCodexThreadId());
        assertEquals("/src-2", agent.getSourceDirectory());
        assertEquals("/work-2", agent.getWorkingDirectory());
        assertEquals("branch-2", agent.getBranch());
    }
}
