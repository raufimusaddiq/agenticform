package com.agenticform.operation;

import com.agenticform.policy.PolicyEffect;
import com.agenticform.task.TaskEntity;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ExternalWorkflowServiceTest {
    private final OperationExternalWaitRepository waits = mock(OperationExternalWaitRepository.class);
    private final OperationRunRepository runs = mock(OperationRunRepository.class);
    private final OperationStepRunRepository steps = mock(OperationStepRunRepository.class);
    private final GitHubActionsGateway github = mock(GitHubActionsGateway.class);
    private final OperationEventService events = mock(OperationEventService.class);
    private final com.agenticform.task.TaskRepository taskRepository = mock(com.agenticform.task.TaskRepository.class);
    private final ExternalWorkflowService service = new ExternalWorkflowService(
            waits, runs, steps, github, events, new ObjectMapper(), taskRepository);

    @Test
    void wrongShaWebhookDoesNotCorrelateToWaitingRun() {
        UUID runId = UUID.randomUUID();
        UUID stepId = UUID.randomUUID();
        OperationExternalWaitEntity wait = new OperationExternalWaitEntity(
                runId, stepId, "DISPATCH", "owner/repo", "deploy.yml", "main", "expected-sha", null,
                java.time.Instant.now().plus(java.time.Duration.ofMinutes(10)));
        when(waits.findAllByStatusOrderByCreatedAtAsc(OperationExternalWaitEntity.Status.WAITING))
                .thenReturn(List.of(wait));

        service.handleWebhook(new ExternalWorkflowService.WorkflowWebhook(
                555, "owner/repo", ".github/workflows/deploy.yml", "main", "different-sha",
                "completed", "success", "https://ci/555", java.time.Instant.now()));

        // The webhook for another SHA must be ignored entirely: the wait stays WAITING,
        // no run/step mutation, no ambiguity failure.
        verify(waits, never()).save(any());
        verify(runs, never()).save(any());
        verify(steps, never()).save(any());
        assertThat(wait.getStatus()).isEqualTo(OperationExternalWaitEntity.Status.WAITING);
    }

    @Test
    void duplicateDispatchCorrelationFailsClosed() {
        OperationRunEntity run = run();
        OperationStepRunEntity step = new OperationStepRunEntity(UUID.randomUUID(), "deploy", "Deploy", "GITHUB_WORKFLOW", 0);
        OperationExternalWaitEntity first = new OperationExternalWaitEntity(
                run.getId(), step.getId(), "DISPATCH", "owner/repo", "deploy.yml", "main", "abc123", null,
                java.time.Instant.now().plus(java.time.Duration.ofMinutes(10)));
        OperationExternalWaitEntity second = new OperationExternalWaitEntity(
                UUID.randomUUID(), UUID.randomUUID(), "DISPATCH", "owner/repo", "deploy.yml", "main", "abc123", null,
                java.time.Instant.now().plus(java.time.Duration.ofMinutes(10)));
        when(waits.findAllByStatusOrderByCreatedAtAsc(OperationExternalWaitEntity.Status.WAITING))
                .thenReturn(List.of(first, second));
        when(waits.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        when(runs.findById(any(UUID.class))).thenReturn(java.util.Optional.empty());
        when(steps.findById(any(UUID.class))).thenReturn(java.util.Optional.empty());

        service.handleWebhook(new ExternalWorkflowService.WorkflowWebhook(
                777, "owner/repo", ".github/workflows/deploy.yml", "main", "abc123",
                "completed", "success", "https://ci/777", java.time.Instant.now()));

        assertThat(first.getStatus()).isEqualTo(OperationExternalWaitEntity.Status.FAILED);
        assertThat(second.getStatus()).isEqualTo(OperationExternalWaitEntity.Status.FAILED);
    }

    @Test
    void mergedPullRequestAdvancesRootToMergedStage() {
        UUID runId = UUID.randomUUID();
        UUID rootTaskId = UUID.randomUUID();
        OperationExternalWaitEntity wait = new OperationExternalWaitEntity(
                runId, UUID.randomUUID(), "WAIT", "owner/repo", "ci.yml", "main", "expected-sha", null,
                java.time.Instant.now().plus(java.time.Duration.ofMinutes(10)));
        when(waits.findAllByStatusOrderByCreatedAtAsc(OperationExternalWaitEntity.Status.WAITING))
                .thenReturn(List.of(wait));
        when(runs.findById(runId)).thenReturn(java.util.Optional.of(
                new OperationRunEntity(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                        UUID.randomUUID(), rootTaskId, "agent:test", "CI", "staging",
                        OperationRunEntity.Status.RUNNING, PolicyEffect.ALLOW, UUID.randomUUID(), "{}", "{}")));
        TaskEntity root = mock(TaskEntity.class);
        when(root.getParentTaskId()).thenReturn(null);
        when(root.getDeliverable()).thenReturn(com.agenticform.task.TaskDeliverable.IMPLEMENTATION);
        when(taskRepository.findById(rootTaskId)).thenReturn(java.util.Optional.of(root));

        service.handleMerge(new ExternalWorkflowService.MergeWebhook(
                "owner/repo", "main", "merge-sha-abc"));

        verify(root).setDeliveryStage(com.agenticform.task.TaskDeliveryStage.MERGED);
        verify(taskRepository).save(root);
    }

    @Test
    void transientGithubLookupDoesNotFailPersistedWait() throws Exception {
        when(waits.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        when(github.listWorkflowRuns("owner/repo", "ci.yml"))
                .thenThrow(new IllegalStateException("temporary github outage"));
        OperationRunEntity run = run();
        OperationStepRunEntity step = new OperationStepRunEntity(UUID.randomUUID(), "ci", "CI", "GITHUB_WORKFLOW", 0);

        service.begin(run, step, new ExternalWorkflowService.BeginRequest(
                "WAIT", "owner/repo", "ci.yml", "main", "abc123", Map.of(), 600));

        assertThat(run.getStatus()).isEqualTo(OperationRunEntity.Status.WAITING_EXTERNAL);
        assertThat(step.getStatus()).isEqualTo(OperationStepRunEntity.Status.WAITING_EXTERNAL);
        verify(runs).save(run);
        verify(steps).save(step);
    }

    @Test
    void dispatchRequiresExplicitExpectedHeadSha() {
        OperationRunEntity run = run();
        OperationStepRunEntity step = new OperationStepRunEntity(UUID.randomUUID(), "deploy", "Deploy", "GITHUB_WORKFLOW", 0);

        assertThatThrownBy(() -> service.begin(run, step, new ExternalWorkflowService.BeginRequest(
                "DISPATCH", "owner/repo", "deploy.yml", "main", null, Map.of("sha", "abc123"), 600)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Durable GitHub workflow waits require expectedHeadSha");
    }

    private OperationRunEntity run() {
        return new OperationRunEntity(
                UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                UUID.randomUUID(), null, "agent:test", "CI", "development",
                OperationRunEntity.Status.RUNNING, PolicyEffect.ALLOW, UUID.randomUUID(), "{}", "{}");
    }
}
