package com.agenticform.task;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.runtime.AgentRuntimeRegistry;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class TaskReportIdentityTest {
    private final UUID taskId = UUID.randomUUID();
    private final UUID agentId = UUID.randomUUID();
    private final UUID projectId = UUID.randomUUID();
    private final AgentEntity agent = mock(AgentEntity.class);
    private final TaskEntity task = mock(TaskEntity.class);
    private final TaskRepository tasks = mock(TaskRepository.class);
    private final AgentRepository agents = mock(AgentRepository.class);
    private final TaskDispatchService service = new TaskDispatchService(tasks, agents,
            mock(AgentRuntimeRegistry.class), mock(ExecutionNodeService.class), mock(TaskDependencyService.class));

    TaskReportIdentityTest() {
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(tasks.findById(taskId)).thenReturn(Optional.of(task));
        when(agent.getId()).thenReturn(agentId);
        when(agent.getProjectId()).thenReturn(projectId);
        when(agent.getRole()).thenReturn(AgentRole.GENERAL);
        when(agent.getActiveTaskId()).thenReturn(taskId);
        when(agent.getRuntimeGeneration()).thenReturn(3L);
        when(task.getId()).thenReturn(taskId);
        when(task.getAssignedAgentId()).thenReturn(agentId);
        when(task.getProjectId()).thenReturn(projectId);
        when(task.getStatus()).thenReturn(TaskStatus.RUNNING);
        when(tasks.save(task)).thenReturn(task);
    }

    @Test
    void deliverableRootResolutionRejectsChildrenAndNonApplicationTasks() {
        UUID rootId = UUID.randomUUID();
        TaskEntity root = new TaskEntity(projectId, agentId, "root", "implement", 0);
        org.springframework.test.util.ReflectionTestUtils.setField(root, "id", rootId);
        root.configureDelivery(TaskDeliverable.IMPLEMENTATION, true, false, true, "production");
        when(tasks.findById(rootId)).thenReturn(Optional.of(root));
        assertEquals(rootId, service.resolveDeliverableRoot(projectId, rootId, null));

        UUID childId = UUID.randomUUID();
        TaskEntity child = new TaskEntity(projectId, agentId, "child", "implement", 0, rootId);
        org.springframework.test.util.ReflectionTestUtils.setField(child, "id", childId);
        child.configureDelivery(TaskDeliverable.IMPLEMENTATION, true, false, true, "production");
        when(tasks.findById(childId)).thenReturn(Optional.of(child));
        assertNull(service.resolveDeliverableRoot(projectId, childId, null));

        TaskEntity analysis = new TaskEntity(projectId, agentId, "analysis", "analyse", 0);
        UUID analysisId = UUID.randomUUID();
        org.springframework.test.util.ReflectionTestUtils.setField(analysis, "id", analysisId);
        analysis.configureDelivery(TaskDeliverable.ANALYSIS, false, false, false, null);
        when(tasks.findById(analysisId)).thenReturn(Optional.of(analysis));
        assertNull(service.resolveDeliverableRoot(projectId, analysisId, null));
        assertNull(service.resolveDeliverableRoot(UUID.randomUUID(), rootId, null));
        assertNull(service.resolveDeliverableRoot(projectId, null, null));
        assertEquals(rootId, service.resolveDeliverableRoot(projectId, null, rootId));
    }

    @Test
    void creationQueuesDurableWorkForIdleOrBusyRecipientWithoutDispatch() {
        when(agent.getCapabilityProfile()).thenReturn(com.agenticform.agent.AgentCapabilityProfile.IMPLEMENTER);
        when(tasks.save(any(TaskEntity.class))).thenAnswer(invocation -> {
            TaskEntity created = invocation.getArgument(0);
            org.springframework.test.util.ReflectionTestUtils.setField(created, "id", UUID.randomUUID());
            return created;
        });
        for (var status : java.util.List.of(com.agenticform.agent.AgentStatus.IDLE, com.agenticform.agent.AgentStatus.WORKING)) {
            when(agent.getStatus()).thenReturn(status);
            TaskEntity created = service.create(agentId, "delegated " + status, "implement", 0);
            assertNotNull(created.getId());
            assertEquals(TaskStatus.READY, created.getStatus());
            assertEquals(agentId, created.getAssignedAgentId());
        }
        verify(agent, never()).setStatus(any());
        verify(agent, never()).setActiveTaskId(any());
    }

    @Test
    void cancelledOrFailedChildrenCannotSatisfyImplementationGate() {
        when(agent.getRole()).thenReturn(AgentRole.ORCHESTRATOR);
        when(agent.getId()).thenReturn(agentId);
        when(task.getDeliverable()).thenReturn(TaskDeliverable.IMPLEMENTATION);
        when(task.isReviewRequired()).thenReturn(true);
        TaskEntity cancelledImplementation = mock(TaskEntity.class);
        when(cancelledImplementation.getId()).thenReturn(UUID.randomUUID());
        when(cancelledImplementation.getStatus()).thenReturn(TaskStatus.CANCELLED);
        when(cancelledImplementation.getDeliverable()).thenReturn(TaskDeliverable.IMPLEMENTATION);
        when(tasks.findAllByParentTaskIdOrderByCreatedAtAsc(taskId)).thenReturn(List.of(cancelledImplementation));
        // A CANCELLED implementation child can never satisfy the required phase, so
        // the orchestrator is blocked from completing. Either rejection type is
        // acceptable; what matters is that no completion is recorded.
        assertThrows(IllegalStateException.class,
                () -> service.report(agentId, taskId, 3, "done"));
        verify(tasks, never()).save(any());
    }

    @Test
    void orchestratorCanReportBlockedWhileDelegatedWorkIsUnresolved() {
        when(agent.getRole()).thenReturn(AgentRole.ORCHESTRATOR);
        when(task.getDeliverable()).thenReturn(TaskDeliverable.GENERAL);
        when(tasks.findAllByParentTaskIdOrderByCreatedAtAsc(taskId)).thenReturn(List.of());
        TaskEvidence evidence = new TaskEvidence(TaskEvidence.BLOCKED, List.of(), List.of(),
                List.of("implementation and review are blocked"), List.of());

        assertSame(task, service.report(agentId, taskId, 3, "Workflow blocked by child tasks", evidence));
        verify(task).recordEvidence(evidence);
        verify(task).setStatus(TaskStatus.BLOCKED);
        verify(task).setLastError("implementation and review are blocked");
        verify(tasks).save(task);
    }

    @Test
    void currentTaskAndGenerationCanReport() {
        org.mockito.Mockito.when(task.getDeliverable()).thenReturn(TaskDeliverable.ANALYSIS);
        TaskEvidence evidence = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.ANALYSIS, "docs/analysis.md", null, null)),
                java.util.List.of(), java.util.List.of(), java.util.List.of());
        assertSame(task, service.report(agentId, taskId, 3, "No blockers; zero failures", evidence));
        verify(task).setReport("No blockers; zero failures");
    }

    @Test
    void generalTaskCompletesWithoutInventedCodeArtifact() {
        when(task.getDeliverable()).thenReturn(TaskDeliverable.GENERAL);
        assertSame(task, service.report(agentId, taskId, 3, "delegation complete"));
        verify(task, never()).recordEvidence(any());
    }

    @Test
    void implementationCannotCompleteOnProseAlone() {
        when(task.getDeliverable()).thenReturn(TaskDeliverable.IMPLEMENTATION);
        var error = assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "implemented; validation"));
        assertEquals("EVIDENCE_REQUIRED", error.code);
        verify(tasks, never()).save(any());
    }

    @Test
    void implementationRejectsWordShapedEvidenceAndUnverifiedValidation() {
        when(task.getDeliverable()).thenReturn(TaskDeliverable.IMPLEMENTATION);
        TaskEvidence noArtifact = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(),
                java.util.List.of(new TaskEvidence.Validation("mvn test", TaskEvidence.Validation.PASSED, null)),
                java.util.List.of(), java.util.List.of());
        assertEquals("IMPLEMENTATION_EVIDENCE_REQUIRED", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "implemented", noArtifact)).code);

        TaskEvidence noValidation = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.COMMIT, "refs/heads/main", "abc123", null)),
                java.util.List.of(), java.util.List.of(), java.util.List.of());
        assertEquals("VALIDATION_REQUIRED", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "implemented", noValidation)).code);

        TaskEvidence revisionless = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.PULL_REQUEST, "PR #1", null, null)),
                java.util.List.of(new TaskEvidence.Validation("mvn test", TaskEvidence.Validation.PASSED, null)),
                java.util.List.of(), java.util.List.of());
        assertEquals("IMPLEMENTATION_EVIDENCE_REQUIRED", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "implemented", revisionless)).code);
    }

    @Test
    void wordsLikeFailuresOrNoBlockersDoNotDecideEvidence() {
        when(task.getDeliverable()).thenReturn(TaskDeliverable.IMPLEMENTATION);
        TaskEvidence evidence = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.COMMIT, "abc123", "abc123", null)),
                java.util.List.of(new TaskEvidence.Validation("mvn test", TaskEvidence.Validation.PASSED, null)),
                java.util.List.of(), java.util.List.of("no blockers; zero failures"));
        assertSame(task, service.report(agentId, taskId, 3, "zero failures; no blockers", evidence));
    }

    @Test
    void unresolvedStructuredBlockerCannotComplete() {
        when(task.getDeliverable()).thenReturn(TaskDeliverable.ANALYSIS);
        TaskEvidence evidence = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.ANALYSIS, "docs/a.md", null, null)),
                java.util.List.of(), java.util.List.of("awaiting approval"), java.util.List.of());
        assertEquals("UNRESOLVED_BLOCKERS", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "done", evidence)).code);
    }

    @Test
    void documentationRequiresDocumentAndPassedCheck() {
        when(task.getDeliverable()).thenReturn(TaskDeliverable.DOCUMENTATION);
        TaskEvidence documentOnly = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.DOCUMENT, "docs/x.md", "rev1", null)),
                java.util.List.of(), java.util.List.of(), java.util.List.of());
        assertEquals("DOCUMENTATION_EVIDENCE_REQUIRED", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "docs written", documentOnly)).code);
        TaskEvidence complete = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.DOCUMENT, "docs/x.md", "rev1", null)),
                java.util.List.of(new TaskEvidence.Validation("link check", TaskEvidence.Validation.PASSED, null)),
                java.util.List.of(), java.util.List.of());
        assertSame(task, service.report(agentId, taskId, 3, "docs written", complete));
    }

    @Test
    void analysisCompletesWithoutInventedCode() {
        when(task.getDeliverable()).thenReturn(TaskDeliverable.ANALYSIS);
        TaskEvidence evidence = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.ANALYSIS, "findings", null, null)),
                java.util.List.of(), java.util.List.of(), java.util.List.of());
        assertSame(task, service.report(agentId, taskId, 3, "analysis complete", evidence));
    }

    @Test
    void applicationChangeCannotCompleteBeforeVerifiedDeployment() {
        when(task.getDeliverable()).thenReturn(TaskDeliverable.IMPLEMENTATION);
        when(task.requiresVerifiedDelivery()).thenReturn(true);
        assertEquals("DELIVERY_CONFIGURATION_REQUIRED", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "implemented")).code);
        when(task.getEnvironmentKey()).thenReturn("production");
        assertEquals("DELIVERY_NOT_VERIFIED", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "implemented")).code);
        when(task.hasVerifiedDelivery()).thenReturn(true);
        TaskEvidence evidence = new TaskEvidence(TaskEvidence.COMPLETED, java.util.List.of(
                new TaskEvidence.Artifact(TaskEvidence.ArtifactType.COMMIT, "abc123", "abc123", null)),
                java.util.List.of(new TaskEvidence.Validation("smoke", TaskEvidence.Validation.PASSED, null)),
                java.util.List.of(), java.util.List.of());
        assertSame(task, service.report(agentId, taskId, 3, "delivered", evidence));
    }

    @Test
    void zeroGenerationIsValidOnlyForLocalRuntime() {
        when(agent.getRuntimeGeneration()).thenReturn(0L);
        assertSame(task, service.report(agentId, taskId, 0, "local result"));
        when(agent.getExecutionNodeId()).thenReturn(UUID.randomUUID());
        assertEquals("STALE_RUNTIME", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 0, "unfenced remote result")).code);
    }

    @Test
    void lateReportCannotAttachToANewerTask() {
        UUID newer = UUID.randomUUID();
        when(agent.getActiveTaskId()).thenReturn(newer);
        var error = assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "late"));
        assertEquals("STALE_TASK", error.code);
        assertEquals(taskId, error.taskId);
        assertEquals(newer, error.activeTaskId);
        verify(tasks, never()).save(any());
    }

    @Test
    void lateBlockerCannotMutateANewerTask() {
        when(agent.getActiveTaskId()).thenReturn(UUID.randomUUID());
        assertEquals("STALE_TASK", assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.block(agentId, taskId, 3, "late blocker")).code);
        verify(tasks, never()).save(any());
    }

    @Test
    void missingActiveTaskReturnsOriginalIdentityWithoutReplacement() {
        when(agent.getActiveTaskId()).thenReturn(null);
        var error = assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 3, "late"));
        assertEquals("STALE_TASK", error.code);
        assertEquals(taskId, error.taskId);
        assertNull(error.activeTaskId);
        verify(tasks, never()).save(any());
    }

    @Test
    void oldGenerationCannotReportOrBlock() {
        var report = assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.report(agentId, taskId, 2, "late"));
        var block = assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> service.block(agentId, taskId, 2, "late blocker"));
        assertEquals("STALE_RUNTIME", report.code);
        assertEquals("STALE_RUNTIME", block.code);
        verify(tasks, never()).save(any());
    }

    @Test
    void nonRunningStatesCannotAcceptReportsOrBlockers() {
        for (TaskStatus status : TaskStatus.values()) {
            if (status == TaskStatus.RUNNING || status == TaskStatus.DISPATCHED) continue;
            when(task.getStatus()).thenReturn(status);
            assertEquals("TASK_NOT_REPORTABLE", assertThrows(TaskDispatchService.ReportRejectedException.class,
                    () -> service.report(agentId, taskId, 3, "done")).code);
            assertThrows(TaskDispatchService.ReportRejectedException.class,
                    () -> service.block(agentId, taskId, 3, "blocked"));
        }
        verify(tasks, never()).save(any());
    }

    @Test
    void anotherProjectOrAgentCannotSupplyEvidence() {
        when(task.getProjectId()).thenReturn(UUID.randomUUID());
        assertThrows(IllegalArgumentException.class, () -> service.report(agentId, taskId, 3, "done"));
        when(task.getProjectId()).thenReturn(projectId);
        when(task.getAssignedAgentId()).thenReturn(UUID.randomUUID());
        assertThrows(IllegalArgumentException.class, () -> service.report(agentId, taskId, 3, "done"));
        verify(tasks, never()).save(any());
    }

    @Test
    void validBlockerPreservesTaskAndRecordsReason() {
        assertSame(task, service.block(agentId, taskId, 3, "Resolve approval"));
        verify(task).setStatus(TaskStatus.BLOCKED);
        verify(task).setLastError("Resolve approval");
        verify(task).setReport("BLOCKER: Resolve approval");
    }

    @Test
    void dispatchIncludesExplicitReportIdentity() {
        when(task.getPrompt()).thenReturn("inspect repository");
        String prompt = TaskDispatchService.promptWithCompletionContract(task, agent);
        assertTrue(prompt.contains("taskId=" + taskId));
        assertTrue(prompt.contains("runtimeGeneration=3"));
    }
}
