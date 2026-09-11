package com.agenticform.operation;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class ExternalWorkflowService {
    public record BeginRequest(String mode, String repository, String workflow, String ref,
                               String expectedHeadSha, Map<String, String> inputs, int timeoutSeconds) {}

    public record WorkflowWebhook(long runId, String repository, String workflowPath,
                                  String headBranch, String headSha, String status,
                                  String conclusion, String htmlUrl, Instant createdAt) {}

    private final OperationExternalWaitRepository waitRepository;
    private final OperationRunRepository runRepository;
    private final OperationStepRunRepository stepRepository;
    private final GitHubActionsGateway gitHubActions;
    private final OperationEventService events;
    private final ObjectMapper mapper;

    public ExternalWorkflowService(OperationExternalWaitRepository waitRepository,
                                   OperationRunRepository runRepository,
                                   OperationStepRunRepository stepRepository,
                                   GitHubActionsGateway gitHubActions,
                                   OperationEventService events,
                                   ObjectMapper mapper) {
        this.waitRepository = waitRepository;
        this.runRepository = runRepository;
        this.stepRepository = stepRepository;
        this.gitHubActions = gitHubActions;
        this.events = events;
        this.mapper = mapper;
    }

    public synchronized void begin(OperationRunEntity run, OperationStepRunEntity step, BeginRequest request) throws Exception {
        String mode = request.mode().toUpperCase(Locale.ROOT);
        if (!mode.equals("WAIT") && !mode.equals("DISPATCH")) throw new IllegalArgumentException("Unsupported GitHub workflow mode: " + mode);
        if (request.expectedHeadSha() == null || request.expectedHeadSha().isBlank()) {
            throw new IllegalArgumentException("Durable GitHub workflow waits require expectedHeadSha");
        }

        Instant correlationNotBefore = null;
        if (mode.equals("DISPATCH")) {
            correlationNotBefore = gitHubActions.dispatchWorkflow(
                    request.repository(), request.workflow(), request.ref(), request.inputs());
        }

        OperationExternalWaitEntity wait = waitRepository.save(new OperationExternalWaitEntity(
                run.getId(), step.getId(), mode, request.repository(), request.workflow(), request.ref(),
                request.expectedHeadSha(), correlationNotBefore,
                Instant.now().plusSeconds(Math.max(1, request.timeoutSeconds()))));
        step.waitExternal("Waiting for GitHub Actions workflow " + request.workflow());
        stepRepository.save(step);
        run.waitExternal();
        runRepository.save(run);

        reconcileOne(wait);
    }

    public synchronized void handleWebhook(WorkflowWebhook webhook) {
        List<OperationExternalWaitEntity> candidates = waitRepository
                .findAllByStatusOrderByCreatedAtAsc(OperationExternalWaitEntity.Status.WAITING).stream()
                .filter(wait -> matches(wait, webhook))
                .toList();
        if (candidates.isEmpty()) return;

        long unboundDispatch = candidates.stream()
                .filter(wait -> wait.getExternalRunId() == null && "DISPATCH".equals(wait.getMode()))
                .count();
        if (unboundDispatch > 1) {
            candidates.stream()
                    .filter(wait -> wait.getExternalRunId() == null && "DISPATCH".equals(wait.getMode()))
                    .forEach(wait -> failWait(wait, "Ambiguous GitHub workflow dispatch correlation; multiple operation waits matched run " + webhook.runId(), false));
            return;
        }

        for (OperationExternalWaitEntity wait : candidates) {
            applyObserved(wait, webhook.runId(), webhook.status(), webhook.conclusion(), webhook.htmlUrl(),
                    webhook.headSha(), webhook.headBranch(), webhook.createdAt());
        }
    }

    @Scheduled(fixedDelayString = "${agenticform.github.reconcile-delay-ms:30000}")
    public synchronized void reconcileWaiting() {
        for (OperationExternalWaitEntity wait : waitRepository
                .findAllByStatusOrderByCreatedAtAsc(OperationExternalWaitEntity.Status.WAITING)) {
            try {
                reconcileOne(wait);
            } catch (Exception ignored) {
                // Webhook is the fast path; reconciliation keeps retrying until the durable deadline.
            }
        }
    }

    private void reconcileOne(OperationExternalWaitEntity wait) throws Exception {
        if (Instant.now().isAfter(wait.getDeadline())) {
            failWait(wait, "Timed out waiting for GitHub Actions workflow " + wait.getWorkflow(), true);
            return;
        }

        if (wait.getExternalRunId() != null) {
            GitHubActionsGateway.WorkflowRun run = gitHubActions.getWorkflowRun(wait.getRepository(), wait.getExternalRunId());
            applyObserved(wait, run.runId(), run.status(), run.conclusion(), run.htmlUrl(),
                    run.headSha(), run.headBranch(), run.createdAt());
            return;
        }

        List<GitHubActionsGateway.WorkflowRun> candidates = gitHubActions
                .listWorkflowRuns(wait.getRepository(), wait.getWorkflow()).stream()
                .filter(run -> wait.getExpectedHeadSha().equals(run.headSha()))
                .filter(run -> wait.getRef().equals(run.headBranch()))
                .filter(run -> wait.getCorrelationNotBefore() == null || !run.createdAt().isBefore(wait.getCorrelationNotBefore()))
                .sorted(Comparator.comparing(GitHubActionsGateway.WorkflowRun::createdAt).reversed())
                .toList();
        if (candidates.isEmpty()) return;
        if ("DISPATCH".equals(wait.getMode()) && candidates.size() > 1) {
            failWait(wait, "Ambiguous GitHub workflow dispatch correlation; multiple runs matched", false);
            return;
        }
        GitHubActionsGateway.WorkflowRun selected = candidates.get(0);
        applyObserved(wait, selected.runId(), selected.status(), selected.conclusion(), selected.htmlUrl(),
                selected.headSha(), selected.headBranch(), selected.createdAt());
    }

    private boolean matches(OperationExternalWaitEntity wait, WorkflowWebhook event) {
        if (wait.getExternalRunId() != null) return wait.getExternalRunId() == event.runId();
        if (!wait.getRepository().equalsIgnoreCase(event.repository())) return false;
        if (!workflowMatches(wait.getWorkflow(), event.workflowPath())) return false;
        if (!wait.getRef().equals(event.headBranch())) return false;
        if (!wait.getExpectedHeadSha().equals(event.headSha())) return false;
        return wait.getCorrelationNotBefore() == null || event.createdAt() == null || !event.createdAt().isBefore(wait.getCorrelationNotBefore());
    }

    private boolean workflowMatches(String expected, String path) {
        if (path == null || path.isBlank()) return false;
        return path.equals(expected) || path.endsWith("/" + expected);
    }

    private void applyObserved(OperationExternalWaitEntity wait, long runId, String status, String conclusion,
                               String htmlUrl, String headSha, String headBranch, Instant createdAt) {
        if (wait.getStatus() != OperationExternalWaitEntity.Status.WAITING) return;
        wait.observe(runId, htmlUrl, status, conclusion);
        waitRepository.save(wait);
        if (!"completed".equalsIgnoreCase(status)) return;

        OperationRunEntity operation = runRepository.findById(wait.getOperationRunId()).orElse(null);
        OperationStepRunEntity step = stepRepository.findById(wait.getStepRunId()).orElse(null);
        if (operation == null || step == null) return;

        long duration = Math.max(0, Duration.between(step.getStartedAt(), Instant.now()).toMillis());
        String evidence = evidence(wait, runId, status, conclusion, htmlUrl, headSha, headBranch, createdAt);
        if ("success".equalsIgnoreCase(conclusion)) {
            wait.succeed();
            waitRepository.save(wait);
            step.succeed("GitHub Actions workflow completed successfully", evidence, null, duration);
            stepRepository.save(step);
            operation.queue();
            runRepository.save(operation);
        } else {
            wait.fail();
            waitRepository.save(wait);
            String reason = "GitHub workflow run " + runId + " completed with conclusion " + conclusion;
            step.fail(reason, evidence, null, duration);
            stepRepository.save(step);
            operation.fail(reason);
            runRepository.save(operation);
            events.publishTerminal(operation);
        }
    }

    private void failWait(OperationExternalWaitEntity wait, String reason, boolean timeout) {
        OperationRunEntity operation = runRepository.findById(wait.getOperationRunId()).orElse(null);
        OperationStepRunEntity step = stepRepository.findById(wait.getStepRunId()).orElse(null);
        if (timeout) wait.timeout(); else wait.fail();
        waitRepository.save(wait);
        if (step != null) {
            long duration = Math.max(0, Duration.between(step.getStartedAt(), Instant.now()).toMillis());
            step.fail(reason, null, null, duration);
            stepRepository.save(step);
        }
        if (operation != null) {
            operation.fail(reason);
            runRepository.save(operation);
            events.publishTerminal(operation);
        }
    }

    private String evidence(OperationExternalWaitEntity wait, long runId, String status, String conclusion,
                            String htmlUrl, String headSha, String headBranch, Instant createdAt) {
        try {
            ObjectNode node = mapper.createObjectNode();
            node.put("provider", "github-actions");
            node.put("repository", wait.getRepository());
            node.put("workflow", wait.getWorkflow());
            node.put("runId", runId);
            node.put("status", status);
            if (conclusion != null) node.put("conclusion", conclusion);
            if (htmlUrl != null) node.put("url", htmlUrl);
            if (headSha != null) node.put("headSha", headSha);
            if (headBranch != null) node.put("headBranch", headBranch);
            if (createdAt != null) node.put("createdAt", createdAt.toString());
            return mapper.writeValueAsString(node);
        } catch (Exception error) {
            return "{\"provider\":\"github-actions\",\"runId\":" + runId + "}";
        }
    }
}
