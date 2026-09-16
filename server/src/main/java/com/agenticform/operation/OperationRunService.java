package com.agenticform.operation;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.policy.DeterministicPolicyEngine;
import com.agenticform.policy.PolicyContext;
import com.agenticform.policy.PolicyDecision;
import com.agenticform.policy.PolicyEffect;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;
import java.util.regex.Pattern;

@Service
public class OperationRunService {
    public record StartRequest(UUID agentId, UUID taskId, String requestedBy, Map<String, String> parameters) {}
    public record RunDetail(OperationRunEntity run, List<OperationStepRunEntity> steps) {}

    private static final Pattern PARAMETER_KEY = Pattern.compile("[A-Za-z0-9_.-]{1,64}");
    private static final Pattern SENSITIVE_PARAMETER = Pattern.compile("(?i)^(secret|token|password|credential|apiKey|privateKey|accessToken|refreshToken)$");

    private final OperationRunRepository runRepository;
    private final OperationStepRunRepository stepRepository;
    private final OperationalRegistryService registry;
    private final OperationalServiceRepository serviceRepository;
    private final AgentRepository agentRepository;
    private final TaskRepository taskRepository;
    private final DeterministicPolicyEngine policyEngine;
    private final OperationEventService events;
    private final ObjectMapper mapper;

    public OperationRunService(OperationRunRepository runRepository,
                               OperationStepRunRepository stepRepository,
                               OperationalRegistryService registry,
                               OperationalServiceRepository serviceRepository,
                               AgentRepository agentRepository,
                               TaskRepository taskRepository,
                               DeterministicPolicyEngine policyEngine,
                               OperationEventService events,
                               ObjectMapper mapper) {
        this.runRepository = runRepository;
        this.stepRepository = stepRepository;
        this.registry = registry;
        this.serviceRepository = serviceRepository;
        this.agentRepository = agentRepository;
        this.taskRepository = taskRepository;
        this.policyEngine = policyEngine;
        this.events = events;
        this.mapper = mapper;
    }

    @PostConstruct
    void recoverInterruptedRuns() {
        for (OperationRunEntity run : runRepository.findAllByStatusIn(List.of(OperationRunEntity.Status.RUNNING))) {
            run.interrupt("Agenticform restarted while a host-local step was running; replay was refused because completion is unknown");
            runRepository.save(run);
            events.publishTerminal(run);
        }
        // QUEUED is picked up by OperationExecutionScheduler. WAITING_EXTERNAL is reconciled
        // by webhook/reconciliation and intentionally survives restart unchanged.
    }

    public List<OperationRunEntity> list(UUID projectId) {
        return projectId == null ? runRepository.findAllByOrderByCreatedAtDesc()
                : runRepository.findAllByProjectIdOrderByCreatedAtDesc(projectId);
    }

    public RunDetail detail(UUID runId) {
        OperationRunEntity run = run(runId);
        return new RunDetail(run, stepRepository.findAllByOperationRunIdOrderByPosition(runId));
    }

    public synchronized OperationRunEntity start(UUID runbookId, StartRequest request) {
        OperationalRunbookEntity runbook = registry.runbook(runbookId);
        if (!runbook.isEnabled()) throw new IllegalStateException("Runbook is disabled: " + runbook.getKey());
        OperationalEnvironmentEntity environment = registry.environment(runbook.getEnvironmentId());
        if (!environment.isEnabled()) throw new IllegalStateException("Environment is disabled: " + environment.getKey());

        UUID agentId = request == null ? null : request.agentId();
        UUID taskId = request == null ? null : request.taskId();
        validateScope(runbook.getProjectId(), agentId, taskId);
        Map<String, String> parameters = normalizeParameters(request == null ? null : request.parameters());
        String requestedBy = normalizeActor(request == null ? null : request.requestedBy(), "operator");

        PolicyDecision decision = policyEngine.evaluate(new PolicyContext(
                runbook.getProjectId(), agentId, taskId, runbook.getAction(), environment.getKey()));
        OperationRunEntity.Status initialStatus = switch (decision.effect()) {
            case ALLOW -> OperationRunEntity.Status.QUEUED;
            case REQUIRE_HUMAN -> OperationRunEntity.Status.WAITING_APPROVAL;
            case DENY -> OperationRunEntity.Status.DENIED;
        };

        OperationRunEntity run = new OperationRunEntity(
                runbook.getProjectId(), runbook.getId(), environment.getId(), agentId, taskId, requestedBy,
                decision.action(), decision.environment(), initialStatus, decision.effect(), decision.matchedRuleId(),
                createSnapshot(runbook, environment), encodeParameters(parameters));
        if (decision.effect() == PolicyEffect.DENY) run.deny(decision.description());
        run = runRepository.save(run);
        if (decision.effect() == PolicyEffect.DENY) events.publishTerminal(run);
        return run;
    }

    public synchronized OperationRunEntity approve(UUID runId, String actor) {
        OperationRunEntity run = run(runId);
        if (run.getStatus() != OperationRunEntity.Status.WAITING_APPROVAL) {
            throw new IllegalStateException("Operation run is not waiting for approval: " + run.getStatus());
        }

        PolicyDecision current = policyEngine.evaluate(new PolicyContext(
                run.getProjectId(), run.getRequestedAgentId(), run.getRequestedTaskId(), run.getAction(), run.getEnvironmentKey()));
        run.updatePolicy(current.effect(), current.matchedRuleId());
        if (current.effect() == PolicyEffect.DENY) {
            run.deny("Policy changed before approval: " + current.description());
            run = runRepository.save(run);
            events.publishTerminal(run);
            return run;
        }

        run.approve(normalizeActor(actor, "operator"));
        markDeliveryDeploying(run);
        return runRepository.save(run);
    }

    /**
     * An approved application-change runbook moves its root task into the
     * DEPLOYING milestone so operators can distinguish "approved and starting"
     * from "still waiting for a decision". Inspection/rollback runs are ignored.
     */
    void markDeliveryDeploying(OperationRunEntity run) {
        if (run.getRequestedTaskId() == null) return;
        String action = run.getAction() == null ? "" : run.getAction().toLowerCase(java.util.Locale.ROOT);
        if (!action.contains("deploy") && !action.contains("release")) return;
        taskRepository.findById(run.getRequestedTaskId()).ifPresent(task -> {
            if (!task.requiresVerifiedDelivery()) return;
            task.setDeliveryStage(com.agenticform.task.TaskDeliveryStage.DEPLOYING);
            taskRepository.save(task);
        });
    }

    public synchronized OperationRunEntity decline(UUID runId, String actor, String reason) {
        OperationRunEntity run = run(runId);
        if (run.getStatus() != OperationRunEntity.Status.WAITING_APPROVAL) {
            throw new IllegalStateException("Operation run is not waiting for approval: " + run.getStatus());
        }
        run.decline(reason == null || reason.isBlank() ? "Operator declined operation" : reason.trim(),
                normalizeActor(actor, "operator"));
        run = runRepository.save(run);
        events.publishTerminal(run);
        return run;
    }

    private OperationRunEntity run(UUID id) {
        return runRepository.findById(id).orElseThrow(() -> new NoSuchElementException("Operation run not found: " + id));
    }

    private void validateScope(UUID projectId, UUID agentId, UUID taskId) {
        if (agentId != null) {
            AgentEntity agent = agentRepository.findById(agentId)
                    .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
            if (!projectId.equals(agent.getProjectId())) throw new IllegalArgumentException("Requested agent belongs to another project");
        }
        if (taskId != null) {
            TaskEntity task = taskRepository.findById(taskId)
                    .orElseThrow(() -> new NoSuchElementException("Task not found: " + taskId));
            if (!projectId.equals(task.getProjectId())) throw new IllegalArgumentException("Requested task belongs to another project");
            if (agentId != null && !agentId.equals(task.getAssignedAgentId())) {
                throw new IllegalArgumentException("Requested task is assigned to another agent");
            }
        }
    }

    private String createSnapshot(OperationalRunbookEntity runbook, OperationalEnvironmentEntity environment) {
        try {
            ObjectNode snapshot = mapper.createObjectNode();
            snapshot.put("runbookId", runbook.getId().toString());
            snapshot.put("key", runbook.getKey());
            snapshot.put("name", runbook.getName());
            snapshot.put("version", runbook.getVersion());
            snapshot.put("action", runbook.getAction());
            snapshot.put("environmentId", environment.getId().toString());
            snapshot.put("environmentKey", environment.getKey());
            snapshot.set("steps", mapper.readTree(runbook.getDefinitionJson()));
            ObjectNode services = snapshot.putObject("services");
            for (OperationalServiceEntity service : serviceRepository.findAllByEnvironmentIdOrderByKey(environment.getId())) {
                if (!service.isEnabled()) continue;
                ObjectNode serviceNode = services.putObject(service.getKey());
                if (service.getHealthUrl() != null) serviceNode.put("healthUrl", service.getHealthUrl());
                if (service.getReadinessUrl() != null) serviceNode.put("readinessUrl", service.getReadinessUrl());
            }
            return mapper.writeValueAsString(snapshot);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to snapshot runbook", error);
        }
    }

    private Map<String, String> normalizeParameters(Map<String, String> input) {
        if (input == null || input.isEmpty()) return Map.of();
        java.util.LinkedHashMap<String, String> normalized = new java.util.LinkedHashMap<>();
        input.forEach((key, value) -> {
            if (key == null || !PARAMETER_KEY.matcher(key).matches()) throw new IllegalArgumentException("Invalid operation parameter key: " + key);
            if (SENSITIVE_PARAMETER.matcher(key).matches()) {
                throw new IllegalArgumentException("Secrets may not be passed as persisted operation parameters: " + key);
            }
            if (value == null) throw new IllegalArgumentException("Operation parameter value is required: " + key);
            if (value.length() > 2048) throw new IllegalArgumentException("Operation parameter is too long: " + key);
            normalized.put(key, value);
        });
        return Map.copyOf(normalized);
    }

    private String encodeParameters(Map<String, String> parameters) {
        try {
            return mapper.writeValueAsString(parameters);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to serialize operation parameters", error);
        }
    }

    private String normalizeActor(String actor, String fallback) {
        String value = actor == null || actor.isBlank() ? fallback : actor.trim();
        if (value.length() > 128) throw new IllegalArgumentException("Actor is too long");
        return value;
    }
}
