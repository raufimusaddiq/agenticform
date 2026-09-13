package com.agenticform.task;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentCapabilityProfile;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.runtime.AgentRuntimeRegistry;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

class TaskDispatchOrchestrationTest {
    @Test
    void orchestratorCannotCompleteWithUnresolvedChild() {
        TaskRepository tasks = mock(TaskRepository.class);
        AgentRepository agents = mock(AgentRepository.class);
        UUID parentId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        TaskEntity parent = mock(TaskEntity.class);
        TaskEntity child = mock(TaskEntity.class);
        AgentEntity orchestrator = mock(AgentEntity.class);
        when(agents.findById(agentId)).thenReturn(Optional.of(orchestrator));
        when(tasks.findById(parentId)).thenReturn(Optional.of(parent));
        when(parent.getAssignedAgentId()).thenReturn(agentId);
        when(parent.getProjectId()).thenReturn(projectId);
        when(orchestrator.getProjectId()).thenReturn(projectId);
        when(orchestrator.getRole()).thenReturn(AgentRole.ORCHESTRATOR);
        when(tasks.findAllByParentTaskIdOrderByCreatedAtAsc(parentId)).thenReturn(List.of(child));
        when(child.getStatus()).thenReturn(TaskStatus.BLOCKED);

        TaskDispatchService service = new TaskDispatchService(tasks, agents, mock(AgentRuntimeRegistry.class),
                mock(ExecutionNodeService.class), mock(TaskDependencyService.class));

        assertThrows(IllegalStateException.class, () -> service.report(agentId, parentId, "done"));
        verify(parent, never()).setReport(anyString());
    }

    @Test
    void implementationSprintCannotCompleteWithArchitectOnlyReport() {
        TaskRepository tasks = mock(TaskRepository.class);
        AgentRepository agents = mock(AgentRepository.class);
        UUID parentId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID childAgentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        TaskEntity parent = mock(TaskEntity.class);
        TaskEntity architectTask = mock(TaskEntity.class);
        AgentEntity orchestrator = mock(AgentEntity.class);
        AgentEntity architect = mock(AgentEntity.class);
        when(agents.findById(agentId)).thenReturn(Optional.of(orchestrator));
        when(agents.findById(childAgentId)).thenReturn(Optional.of(architect));
        when(tasks.findById(parentId)).thenReturn(Optional.of(parent));
        when(parent.getAssignedAgentId()).thenReturn(agentId);
        when(parent.getProjectId()).thenReturn(projectId);
        when(parent.getPrompt()).thenReturn("Product Requirements Document: build the extraction feature");
        when(orchestrator.getProjectId()).thenReturn(projectId);
        when(orchestrator.getRole()).thenReturn(AgentRole.ORCHESTRATOR);
        when(tasks.findAllByParentTaskIdOrderByCreatedAtAsc(parentId)).thenReturn(List.of(architectTask));
        when(tasks.findAllByParentTaskIdOrderByCreatedAtAsc(any())).thenReturn(List.of());
        when(architectTask.getId()).thenReturn(UUID.randomUUID());
        when(architectTask.getAssignedAgentId()).thenReturn(childAgentId);
        when(architectTask.getStatus()).thenReturn(TaskStatus.COMPLETED);
        when(architectTask.getReport()).thenReturn("Changed files: none. Read-only architecture review.");
        when(architect.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.ARCHITECT);

        TaskDispatchService service = new TaskDispatchService(tasks, agents, mock(AgentRuntimeRegistry.class),
                mock(ExecutionNodeService.class), mock(TaskDependencyService.class));

        assertThrows(IllegalStateException.class, () -> service.report(agentId, parentId, "sprint complete"));
    }

    @Test
    void blockedReviewReportCannotSatisfyImplementationGate() {
        TaskRepository tasks = mock(TaskRepository.class);
        AgentRepository agents = mock(AgentRepository.class);
        UUID parentId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID childAgentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        TaskEntity parent = mock(TaskEntity.class);
        TaskEntity reviewTask = mock(TaskEntity.class);
        AgentEntity orchestrator = mock(AgentEntity.class);
        AgentEntity reviewer = mock(AgentEntity.class);
        when(agents.findById(agentId)).thenReturn(Optional.of(orchestrator));
        when(agents.findById(childAgentId)).thenReturn(Optional.of(reviewer));
        when(tasks.findById(parentId)).thenReturn(Optional.of(parent));
        when(parent.getAssignedAgentId()).thenReturn(agentId);
        when(parent.getProjectId()).thenReturn(projectId);
        when(parent.getPrompt()).thenReturn("PRD: implement the feature");
        when(orchestrator.getProjectId()).thenReturn(projectId);
        when(orchestrator.getRole()).thenReturn(AgentRole.ORCHESTRATOR);
        when(tasks.findAllByParentTaskIdOrderByCreatedAtAsc(parentId)).thenReturn(List.of(reviewTask));
        when(tasks.findAllByParentTaskIdOrderByCreatedAtAsc(any())).thenReturn(List.of());
        when(reviewTask.getId()).thenReturn(UUID.randomUUID());
        when(reviewTask.getAssignedAgentId()).thenReturn(childAgentId);
        when(reviewTask.getStatus()).thenReturn(TaskStatus.COMPLETED);
        when(reviewTask.getKind()).thenReturn(TaskKind.REVIEW);
        when(reviewTask.getReport()).thenReturn("BLOCK remains: full PRD scope is incomplete");
        when(reviewer.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.REVIEWER);

        TaskDispatchService service = new TaskDispatchService(tasks, agents, mock(AgentRuntimeRegistry.class),
                mock(ExecutionNodeService.class), mock(TaskDependencyService.class));

        assertThrows(IllegalStateException.class, () -> service.report(agentId, parentId, "sprint complete"));
    }

    @Test
    void taskKindRequiresMatchingCapability() {
        TaskRepository tasks = mock(TaskRepository.class);
        AgentRepository agents = mock(AgentRepository.class);
        UUID agentId = UUID.randomUUID();
        AgentEntity reviewer = mock(AgentEntity.class);
        when(agents.findById(agentId)).thenReturn(Optional.of(reviewer));
        when(reviewer.getRole()).thenReturn(AgentRole.GENERAL);
        when(reviewer.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.REVIEWER);
        when(reviewer.getProjectId()).thenReturn(UUID.randomUUID());
        TaskDispatchService service = new TaskDispatchService(tasks, agents, mock(AgentRuntimeRegistry.class),
                mock(ExecutionNodeService.class), mock(TaskDependencyService.class));

        assertThrows(IllegalArgumentException.class, () -> service.create(agentId, "implementation", "write it", 0,
                List.of(), null, TaskKind.IMPLEMENTATION));
    }
}
