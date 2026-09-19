package com.agenticform.agent;

import com.agenticform.codex.CodexThreadConfiguration;
import com.agenticform.task.TaskDeliverable;
import com.agenticform.task.TaskDispatchService;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * Read-only scopes must produce zero unintended writes: non-writer profiles never
 * receive a writable sandbox, cannot accept implementation deliverables, and are
 * refused WRITE-gated dynamic tools.
 */
class ReadOnlyScopeIsolationTest {
    private final CodexThreadConfiguration configuration = new CodexThreadConfiguration(new ObjectMapper());

    @Test
    void nonWriterProfilesNeverReceiveAWorkspaceWriteSandbox() {
        for (AgentCapabilityProfile profile : AgentCapabilityProfile.values()) {
            String sandbox = configuration.startParams("/tmp", "responsibility", profile).path("sandbox").asText();
            if (profile.allows(AgentCapabilityProfile.Capability.WRITE)) {
                assertEquals("workspace-write", sandbox, profile.name());
            } else {
                assertEquals("read-only", sandbox, profile.name() + " must never be able to write");
            }
        }
    }

    @Test
    void analysisAndDocumentationProfilesCannotAcceptImplementationDeliverables() {
        for (AgentCapabilityProfile profile : List.of(AgentCapabilityProfile.ARCHITECT,
                AgentCapabilityProfile.REVIEWER, AgentCapabilityProfile.ORCHESTRATOR)) {
            assertFalse(profile.allows(AgentCapabilityProfile.Capability.WRITE),
                    profile.name() + " must not hold WRITE");
        }
    }

    @Test
    void writeGatedToolsAreRefusedForReadOnlyProfiles() {
        AgentCapabilityPolicy policy = new AgentCapabilityPolicy();
        for (AgentCapabilityProfile profile : AgentCapabilityProfile.values()) {
            AgentEntity agent = mock(AgentEntity.class);
            when(agent.getCapabilityProfile()).thenReturn(profile);
            if (profile.allows(AgentCapabilityProfile.Capability.WRITE)) {
                assertDoesNotThrow(() -> policy.require(agent, AgentCapabilityProfile.Capability.WRITE));
            } else {
                assertThrows(IllegalStateException.class,
                        () -> policy.require(agent, AgentCapabilityProfile.Capability.WRITE), profile.name());
            }
        }
    }

    @Test
    void implementationDeliverableRequiresWriteCapabilityAtCreation() {
        var agents = mock(AgentRepository.class);
        var tasks = mock(com.agenticform.task.TaskRepository.class);
        var agent = mock(AgentEntity.class);
        var agentId = java.util.UUID.randomUUID();
        when(agents.findById(agentId)).thenReturn(java.util.Optional.of(agent));
        when(agent.getRole()).thenReturn(AgentRole.GENERAL);
        when(agent.getProjectId()).thenReturn(java.util.UUID.randomUUID());
        when(agent.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.REVIEWER);

        TaskDispatchService service = new TaskDispatchService(tasks, agents,
                mock(com.agenticform.runtime.AgentRuntimeRegistry.class),
                mock(com.agenticform.node.ExecutionNodeService.class),
                mock(com.agenticform.task.TaskDependencyService.class));

        assertThrows(IllegalArgumentException.class, () -> service.create(agentId, "impl", "write it", 0,
                List.of(), null, com.agenticform.task.TaskKind.GENERAL,
                new TaskDispatchService.DeliveryRequest(TaskDeliverable.IMPLEMENTATION, true, false, true, "staging")));
    }
}
