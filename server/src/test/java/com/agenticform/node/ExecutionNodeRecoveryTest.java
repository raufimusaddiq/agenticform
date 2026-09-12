package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.config.AgenticformProperties;
import com.agenticform.runtime.RuntimeType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ExecutionNodeRecoveryTest {
    @Mock ExecutionNodeRepository nodes;
    @Mock NodeEnrollmentTokenRepository tokens;
    @Mock NodeCommandRepository commands;
    @Mock AgentRepository agents;
    @Mock NodeRuntimeSnapshotRepository snapshots;
    @Mock NodeCommandEntity command;
    @Mock AgentEntity agent;

    private ExecutionNodeService service;

    @BeforeEach
    void setUp() {
        service = new ExecutionNodeService(nodes, tokens, commands, agents, snapshots,
                new AgenticformProperties(), new ObjectMapper());
    }

    @Test
    void identicalSuccessfulCompletionIsIdempotent() {
        UUID nodeId = UUID.randomUUID();
        UUID commandId = UUID.randomUUID();
        when(commands.findByIdForUpdate(commandId)).thenReturn(Optional.of(command));
        when(command.getNodeId()).thenReturn(nodeId);
        when(command.getStatus()).thenReturn(NodeCommandEntity.Status.SUCCEEDED);
        when(command.getResultJson()).thenReturn("{\"turnId\":\"turn-1\"}");

        ExecutionNodeService.CommandCompletion completion = service.complete(
                nodeId, commandId, true, "{\"turnId\":\"turn-1\"}", null);

        assertFalse(completion.newlyCompleted());
        verify(commands, never()).save(command);
    }

    @Test
    void conflictingDuplicateCompletionIsRejected() {
        UUID nodeId = UUID.randomUUID();
        UUID commandId = UUID.randomUUID();
        when(commands.findByIdForUpdate(commandId)).thenReturn(Optional.of(command));
        when(command.getNodeId()).thenReturn(nodeId);
        when(command.getStatus()).thenReturn(NodeCommandEntity.Status.SUCCEEDED);
        when(command.getResultJson()).thenReturn("{\"turnId\":\"turn-1\"}");

        assertThrows(IllegalStateException.class,
                () -> service.complete(nodeId, commandId, true, "{\"turnId\":\"different\"}", null));
    }

    @Test
    void staleRuntimeCompletionIsCancelledAndRejected() {
        UUID nodeId = UUID.randomUUID();
        UUID commandId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        when(commands.findByIdForUpdate(commandId)).thenReturn(Optional.of(command));
        when(command.getNodeId()).thenReturn(nodeId);
        when(command.getAgentId()).thenReturn(agentId);
        when(command.getRuntimeGeneration()).thenReturn(3L);
        when(command.getPayloadJson()).thenReturn("{\"runtimeType\":\"CODEX\"}");
        when(command.getStatus()).thenReturn(NodeCommandEntity.Status.LEASED);
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.ownsRuntime(nodeId, 3L, RuntimeType.CODEX, null)).thenReturn(false);

        assertThrows(IllegalStateException.class,
                () -> service.complete(nodeId, commandId, true, "{}", null));

        verify(command).cancel("Stale runtime completion was fenced");
        verify(commands).save(command);
        verify(command, never()).succeed("{}");
    }

    @Test
    void heartbeatBindsFirstSessionAfterStartCompletionIsLost() {
        UUID nodeId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        ExecutionNodeEntity node = org.mockito.Mockito.mock(ExecutionNodeEntity.class);
        ExecutionNodeService.Heartbeat heartbeat = new ExecutionNodeService.Heartbeat(1, "{}", "{}", 1,
                "linux", "amd64", "node", "test", "", 1, 1L, 1L,
                java.util.List.of(new ExecutionNodeService.RuntimeObservation(agentId, RuntimeType.CODEX, 4L,
                        "session-4", "/repo", "/work", "agent/work", "IDLE")));

        when(nodes.findById(nodeId)).thenReturn(Optional.of(node));
        when(nodes.save(node)).thenReturn(node);
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.ownsRuntimeAssignment(nodeId, 4L, RuntimeType.CODEX)).thenReturn(true);
        when(agent.ownsRuntime(nodeId, 4L, RuntimeType.CODEX, "session-4")).thenReturn(false);
        when(agent.getRuntimeSessionId()).thenReturn(null);
        when(snapshots.findByNodeIdAndAgentId(nodeId, agentId)).thenReturn(Optional.empty());

        service.heartbeat(nodeId, heartbeat);

        verify(agent).recoverFromSnapshot(4L, "session-4", "/repo", "/work", "agent/work");
        verify(agents).save(agent);
    }
}
