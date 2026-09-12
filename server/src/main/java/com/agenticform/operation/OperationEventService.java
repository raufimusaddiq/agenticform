package com.agenticform.operation;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.agent.AgentStatus;
import com.agenticform.codex.CodexGateway;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class OperationEventService {
    private static final int MAX_ATTEMPTS = 5;

    private final OperationEventRepository repository;
    private final AgentRepository agentRepository;
    private final CodexGateway codexGateway;
    private final OperationalSignalService signals;

    public OperationEventService(OperationEventRepository repository,
                                 AgentRepository agentRepository,
                                 CodexGateway codexGateway,
                                 OperationalSignalService signals) {
        this.repository = repository;
        this.agentRepository = agentRepository;
        this.codexGateway = codexGateway;
        this.signals = signals;
    }

    public synchronized void publishTerminal(OperationRunEntity run) {
        String eventType = "OPERATION_" + run.getStatus().name();
        if (repository.findByOperationRunIdAndEventType(run.getId(), eventType).isPresent()) return;

        UUID targetAgentId = resolveOperationalAgent(run).map(AgentEntity::getId).orElse(null);
        String payload = "Operation %s is %s. action=%s environment=%s%s".formatted(
                run.getId(), run.getStatus(), run.getAction(), run.getEnvironmentKey(),
                run.getLastError() == null ? "" : " error=" + bounded(run.getLastError()));
        repository.save(new OperationEventEntity(run.getId(), run.getProjectId(), targetAgentId, eventType, payload));

        boolean failed = run.getStatus() == OperationRunEntity.Status.FAILED
                || run.getStatus() == OperationRunEntity.Status.INTERRUPTED;
        signals.record(new OperationalSignalService.SignalInput(
                run.getProjectId(), OperationalSignalSource.OPERATION,
                failed ? "OPERATION_FAILED" : "OPERATION_" + run.getStatus().name(),
                failed ? OperationalSeverity.HIGH : OperationalSeverity.INFO,
                "operation:" + run.getId() + ":" + run.getStatus(),
                "operation:" + run.getAction() + ":" + run.getEnvironmentKey(),
                Map.of(
                        "runId", run.getId().toString(),
                        "action", run.getAction(),
                        "environment", run.getEnvironmentKey(),
                        "status", run.getStatus().name(),
                        "error", run.getLastError() == null ? "" : bounded(run.getLastError())),
                Instant.now()));
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.operation-event-delay-ms:2000}")
    public synchronized void deliverPending() {
        var deliverable = repository.findTop50ByStatusInOrderByCreatedAtAsc(
                List.of(OperationEventEntity.Status.PENDING, OperationEventEntity.Status.FAILED));
        for (OperationEventEntity event : deliverable) {
            if (event.getAttempts() >= MAX_ATTEMPTS) continue;
            try {
                AgentEntity target = resolveTarget(event);
                if (target.getStatus() == AgentStatus.STOPPED) {
                    throw new IllegalStateException("Operational Agent is stopped");
                }
                if (target.getExecutionNodeId() != null) {
                    // Remote Operational Agents receive failure response through the incident wake path.
                    // Successful terminal notifications remain best-effort until the generic operational notice
                    // dispatcher replaces this legacy event channel.
                    if (event.getEventType().equals("OPERATION_SUCCEEDED")) {
                        event.failed("Remote Operational Agent success notification deferred to operational intelligence");
                        repository.save(event);
                        continue;
                    }
                    throw new IllegalStateException("Remote Operational Agent uses durable incident delivery for failures");
                }
                CodexGateway.DispatchReceipt receipt = codexGateway.dispatchTask(
                        target.getCodexThreadId(),
                        "agenticform-operation-event:" + event.getId(),
                        deliveryPrompt(event));
                event.delivered(receipt.queuedSubmissionId(), receipt.turnId());
            } catch (RuntimeException error) {
                event.failed(bounded(error.getMessage()));
            }
            repository.save(event);
        }
    }

    private java.util.Optional<AgentEntity> resolveOperationalAgent(OperationRunEntity run) {
        if (run.getRequestedAgentId() != null) {
            var requested = agentRepository.findById(run.getRequestedAgentId());
            if (requested.isPresent() && requested.get().getRole() == AgentRole.OPERATIONAL) return requested;
        }
        return agentRepository.findByProjectIdAndRole(run.getProjectId(), AgentRole.OPERATIONAL);
    }

    private AgentEntity resolveTarget(OperationEventEntity event) {
        if (event.getTargetAgentId() != null) {
            var existing = agentRepository.findById(event.getTargetAgentId());
            if (existing.isPresent() && existing.get().getRole() == AgentRole.OPERATIONAL) return existing.get();
        }
        AgentEntity operational = agentRepository.findByProjectIdAndRole(event.getProjectId(), AgentRole.OPERATIONAL)
                .orElseThrow(() -> new IllegalStateException("Project has no Operational Agent for event delivery"));
        event.setTargetAgentId(operational.getId());
        return operational;
    }

    private String deliveryPrompt(OperationEventEntity event) {
        return """
                Agenticform operational event.

                Event: %s
                Operation run: %s
                %s

                Use agenticform.get_operation_status with runId %s to inspect durable step evidence.
                Continue operational reasoning from the result: report success, investigate failure, request rollback,
                or hand source-code work back to a coding agent when appropriate. Do not rerun a successful operation merely
                because this notification was retried.
                """.formatted(event.getEventType(), event.getOperationRunId(), event.getPayload(), event.getOperationRunId());
    }

    private String bounded(String value) {
        if (value == null || value.isBlank()) return "unknown error";
        return value.length() > 1500 ? value.substring(0, 1500) + "…" : value;
    }
}
