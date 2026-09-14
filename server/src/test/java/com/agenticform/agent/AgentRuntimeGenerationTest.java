package com.agenticform.agent;

import com.agenticform.workspace.WorkspaceMode;
import com.agenticform.runtime.RuntimeType;
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
        agent.setRuntimeType(RuntimeType.CODEX);

        assertEquals(1L, agent.getRuntimeGeneration());
        assertTrue(agent.ownsRuntime(nodeA, 1, RuntimeType.CODEX, null));

        long generation = agent.reassignRuntime(nodeB, "recovery/coder-g2");

        assertEquals(2L, generation);
        assertFalse(agent.ownsRuntime(nodeA, 1, RuntimeType.CODEX, null));
        assertTrue(agent.ownsRuntime(nodeB, 2, RuntimeType.CODEX, null));
        assertEquals(AgentStatus.STARTING, agent.getStatus());
        assertThrows(IllegalStateException.class,
                () -> agent.bindRuntime(1, RuntimeType.CODEX, "stale-thread", "/src", "/work", "old"));

        agent.bindRuntime(2, RuntimeType.CODEX, "thread-2", "/src", "/work", "recovery/coder-g2");
        assertEquals("thread-2", agent.getRuntimeSessionId());
        assertEquals(com.agenticform.runtime.RuntimeType.CODEX, agent.getRuntimeType());
        assertEquals(AgentStatus.IDLE, agent.getStatus());
        assertFalse(agent.ownsRuntime(nodeB, 2, RuntimeType.CODEX, "other-session"));
    }

    @Test
    void staleSnapshotCannotOverwriteCurrentRuntime() {
        UUID node = UUID.randomUUID();
        AgentEntity agent = new AgentEntity(
                UUID.randomUUID(), "coder", "code", null,
                WorkspaceMode.ISOLATED_WORKTREE, null, null, "agent/coder",
                AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP,
                AgentRole.GENERAL, false, node);
        agent.setRuntimeType(RuntimeType.CODEX);
        agent.bindRuntime(1, RuntimeType.CODEX, "thread-1", "/src-1", "/work-1", "branch-1");
        agent.reassignRuntime(node, "branch-2");
        agent.bindRuntime(2, RuntimeType.CODEX, "thread-2", "/src-2", "/work-2", "branch-2");

        agent.recoverFromSnapshot(1, "stale-thread", "/stale-src", "/stale-work", "stale-branch");

        assertEquals("thread-2", agent.getRuntimeSessionId());
        assertEquals("/src-2", agent.getSourceDirectory());
        assertEquals("/work-2", agent.getWorkingDirectory());
        assertEquals("branch-2", agent.getBranch());
    }

    @Test
    void daemonRestartInvalidatesSessionAndFencesOldGeneration() {
        UUID node = UUID.randomUUID();
        AgentEntity agent = new AgentEntity(
                UUID.randomUUID(), "coder", "code", "thread-1",
                WorkspaceMode.ISOLATED_WORKTREE, "/src", "/work", "agent/coder",
                AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP,
                AgentRole.GENERAL, false, node);
        agent.setRuntimeType(RuntimeType.CODEX);

        agent.invalidateRuntime();

        assertEquals(2L, agent.getRuntimeGeneration());
        assertEquals(AgentStatus.DISCONNECTED, agent.getStatus());
        assertFalse(agent.ownsRuntime(node, 1, RuntimeType.CODEX, "thread-1"));
        assertTrue(agent.ownsRuntimeAssignment(node, 2, RuntimeType.CODEX));
    }
}
