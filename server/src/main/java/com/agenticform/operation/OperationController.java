package com.agenticform.operation;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/operations")
public class OperationController {
    private final OperationalRegistryService registry;
    private final OperationRunService runs;
    private final RepositoryRunbookDiscovery discovery;

    public OperationController(OperationalRegistryService registry, OperationRunService runs,
                               RepositoryRunbookDiscovery discovery) {
        this.registry = registry;
        this.runs = runs;
        this.discovery = discovery;
    }

    /** Resolves the repository-owned runbook without registering anything. */
    @GetMapping("/runbooks/plan")
    public RepositoryRunbookDiscovery.Plan runbookPlan(@RequestParam UUID projectId,
                                                       @RequestParam(required = false) String environmentKey) {
        return discovery.plan(projectId, environmentKey);
    }

    /**
     * Registers the repository-owned runbook when the repository declares one, and
     * reports the standard human-gated fallback when it does not. Registration never
     * executes anything: runs still start through {@code POST /runbooks/{id}/runs}
     * and evaluate deterministic policy.
     */
    @PostMapping("/runbooks/sync")
    public RepositoryRunbookDiscovery.Plan syncRunbook(@RequestParam UUID projectId,
                                                       @RequestParam(required = false) String environmentKey) {
        return discovery.sync(projectId, environmentKey);
    }

    @GetMapping("/environments")
    public List<OperationalEnvironmentEntity> environments(@RequestParam(required = false) UUID projectId) {
        return registry.environments(projectId);
    }

    @PostMapping("/environments")
    public OperationalEnvironmentEntity createEnvironment(@Valid @RequestBody EnvironmentRequest request) {
        return registry.createEnvironment(request.projectId(), request.key(), request.displayName(), request.kind());
    }

    @PutMapping("/environments/{id}")
    public OperationalEnvironmentEntity updateEnvironment(@PathVariable UUID id, @Valid @RequestBody UpdateEnvironmentRequest request) {
        return registry.updateEnvironment(id, request.displayName(), request.kind(), request.enabled());
    }

    @GetMapping("/services")
    public List<OperationalServiceEntity> services(@RequestParam(required = false) UUID projectId) {
        return registry.services(projectId);
    }

    @PostMapping("/services")
    public OperationalServiceEntity createService(@Valid @RequestBody ServiceRequest request) {
        return registry.createService(request.projectId(), request.environmentId(), request.key(), request.displayName(),
                request.healthUrl(), request.readinessUrl());
    }

    @PutMapping("/services/{id}")
    public OperationalServiceEntity updateService(@PathVariable UUID id, @Valid @RequestBody UpdateServiceRequest request) {
        return registry.updateService(id, request.displayName(), request.healthUrl(), request.readinessUrl(), request.enabled());
    }

    @GetMapping("/runbooks")
    public List<RunbookView> runbooks(@RequestParam(required = false) UUID projectId) {
        return registry.runbooks(projectId).stream().map(this::view).toList();
    }

    @PostMapping("/runbooks")
    public RunbookView createRunbook(@Valid @RequestBody RunbookRequest request) {
        OperationalRunbookEntity created = registry.createRunbook(
                request.projectId(), request.environmentId(), request.key(), request.name(), request.action(),
                request.description(), request.steps().stream().map(this::step).toList());
        return view(created);
    }

    @PutMapping("/runbooks/{id}")
    public RunbookView updateRunbook(@PathVariable UUID id, @Valid @RequestBody UpdateRunbookRequest request) {
        OperationalRunbookEntity updated = registry.updateRunbook(id, request.name(), request.action(), request.description(),
                request.steps().stream().map(this::step).toList(), request.enabled());
        return view(updated);
    }

    @GetMapping("/runs")
    public List<OperationRunEntity> runs(@RequestParam(required = false) UUID projectId) {
        return runs.list(projectId);
    }

    @GetMapping("/runs/{id}")
    public OperationRunService.RunDetail run(@PathVariable UUID id) {
        return runs.detail(id);
    }

    @PostMapping("/runbooks/{id}/runs")
    public OperationRunEntity start(@PathVariable UUID id, @RequestBody(required = false) StartRunRequest request) {
        StartRunRequest value = request == null ? new StartRunRequest(null, null, null, Map.of()) : request;
        return runs.start(id, new OperationRunService.StartRequest(
                value.agentId(), value.taskId(), value.requestedBy(), value.parameters()));
    }

    @PostMapping("/runs/{id}/approve")
    public OperationRunEntity approve(@PathVariable UUID id, @RequestBody(required = false) DecisionRequest request) {
        return runs.approve(id, request == null ? null : request.actor());
    }

    @PostMapping("/runs/{id}/decline")
    public OperationRunEntity decline(@PathVariable UUID id, @RequestBody(required = false) DecisionRequest request) {
        return runs.decline(id, request == null ? null : request.actor(), request == null ? null : request.reason());
    }

    private RunbookView view(OperationalRunbookEntity runbook) {
        OperationalEnvironmentEntity environment = registry.environment(runbook.getEnvironmentId());
        return new RunbookView(
                runbook.getId(), runbook.getProjectId(), runbook.getEnvironmentId(), environment.getKey(),
                runbook.getKey(), runbook.getName(), runbook.getAction(), runbook.getDescription(),
                runbook.isEnabled(), runbook.getVersion(), registry.decodeSteps(runbook.getDefinitionJson()),
                runbook.getSource(), runbook.getSourceRepository(), runbook.getSourceCommit(), runbook.getSourcePath(),
                runbook.getCreatedAt(), runbook.getUpdatedAt());
    }

    private OperationalRegistryService.StepSpec step(RunbookStepRequest step) {
        return new OperationalRegistryService.StepSpec(
                step.key(), step.name(), step.type(), step.config(), step.timeoutSeconds() == null ? 120 : step.timeoutSeconds());
    }

    public record EnvironmentRequest(
            @NotNull UUID projectId,
            @NotBlank String key,
            @NotBlank String displayName,
            @NotNull OperationalEnvironmentEntity.Kind kind
    ) {}

    public record UpdateEnvironmentRequest(
            @NotBlank String displayName,
            @NotNull OperationalEnvironmentEntity.Kind kind,
            boolean enabled
    ) {}

    public record ServiceRequest(
            @NotNull UUID projectId,
            @NotNull UUID environmentId,
            @NotBlank String key,
            @NotBlank String displayName,
            String healthUrl,
            String readinessUrl
    ) {}

    public record UpdateServiceRequest(
            @NotBlank String displayName,
            String healthUrl,
            String readinessUrl,
            boolean enabled
    ) {}

    public record RunbookStepRequest(
            @NotBlank String key,
            @NotBlank String name,
            @NotNull OperationalRegistryService.StepType type,
            JsonNode config,
            Integer timeoutSeconds
    ) {}

    public record RunbookRequest(
            @NotNull UUID projectId,
            @NotNull UUID environmentId,
            @NotBlank String key,
            @NotBlank String name,
            @NotBlank String action,
            @NotBlank String description,
            @NotNull List<@Valid RunbookStepRequest> steps
    ) {}

    public record UpdateRunbookRequest(
            @NotBlank String name,
            @NotBlank String action,
            @NotBlank String description,
            @NotNull List<@Valid RunbookStepRequest> steps,
            boolean enabled
    ) {}

    public record StartRunRequest(UUID agentId, UUID taskId, String requestedBy, Map<String, String> parameters) {}
    public record DecisionRequest(String actor, String reason) {}

    public record RunbookView(
            UUID id,
            UUID projectId,
            UUID environmentId,
            String environmentKey,
            String key,
            String name,
            String action,
            String description,
            boolean enabled,
            int version,
            List<OperationalRegistryService.StepSpec> steps,
            String source,
            String sourceRepository,
            String sourceCommit,
            String sourcePath,
            java.time.Instant createdAt,
            java.time.Instant updatedAt
    ) {}
}
