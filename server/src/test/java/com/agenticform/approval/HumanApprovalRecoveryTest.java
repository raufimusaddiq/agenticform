package com.agenticform.approval;

import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.HumanControlMode;
import com.agenticform.node.RemoteCodexInteractionService;
import com.agenticform.node.RemoteInteractionContext;
import com.agenticform.policy.PolicyPreauthorizationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class HumanApprovalRecoveryTest {
    @Mock HumanApprovalRepository repository;
    @Mock AgentRepository agents;
    @Mock HumanApprovalPolicy policy;
    @Mock PolicyPreauthorizationService preauthorizations;
    @Mock RemoteInteractionContext remoteContext;
    @Mock RemoteCodexInteractionService remoteInteractions;

    private HumanApprovalService service;

    @BeforeEach
    void setUp() {
        service = new HumanApprovalService(repository, agents, policy, preauthorizations,
                remoteContext, remoteInteractions, new ObjectMapper());
    }

    @Test
    void restartKeepsRemoteApprovalPendingButOrphansDetachedLocalApproval() {
        UUID remoteAgentId = UUID.randomUUID();
        UUID localAgentId = UUID.randomUUID();
        HumanApprovalEntity remote = approval(remoteAgentId);
        remote.attachRemoteInteraction(UUID.randomUUID());
        HumanApprovalEntity local = approval(localAgentId);

        when(repository.findAllByStatus(HumanApprovalStatus.PENDING)).thenReturn(List.of(remote, local));
        when(repository.save(local)).thenReturn(local);
        when(agents.findById(localAgentId)).thenReturn(Optional.empty());

        service.recoverOrphanedRequests();

        assertEquals(HumanApprovalStatus.PENDING, remote.getStatus());
        assertEquals(HumanApprovalStatus.ORPHANED, local.getStatus());
        verify(repository, never()).save(remote);
        verify(repository).save(local);
    }

    private HumanApprovalEntity approval(UUID agentId) {
        return new HumanApprovalEntity(
                UUID.randomUUID(), agentId, "request-1",
                "item/commandExecution/requestApproval",
                HumanApprovalType.COMMAND_EXECUTION,
                HumanControlMode.ON_THE_LOOP,
                HumanApprovalRisk.HIGH,
                HumanApprovalStatus.PENDING,
                "thread-1", "turn-1", null,
                "Approve command", "{}");
    }
}
