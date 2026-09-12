package com.agenticform.operation;

import com.agenticform.policy.PolicyEffect;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ExternalWorkflowServiceTest {
    private final OperationExternalWaitRepository waits = mock(OperationExternalWaitRepository.class);
    private final OperationRunRepository runs = mock(OperationRunRepository.class);
    private final OperationStepRunRepository steps = mock(OperationStepRunRepository.class);
    private final GitHubActionsGateway github = mock(GitHubActionsGateway.class);
    private final OperationEventService events = mock(OperationEventService.class);
    private final ExternalWorkflowService service = new ExternalWorkflowService(
            waits, runs, steps, github, events, new ObjectMapper());

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
