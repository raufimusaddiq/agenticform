package com.agenticform.operation;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.agent.AgentStatus;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.node.NodeCommandEntity;
import com.agenticform.node.NodeCommandRepository;
import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.runtime.RuntimeDispatchReceipt;
import com.agenticform.runtime.RuntimeSession;
import com.agenticform.runtime.RuntimeType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class OperationEventService {
    private static final int MAX_ATTEMPTS = 5;

    private final OperationEventRepository repository;
    private final AgentRepository agentRepository;
    private final AgentRuntimeRegistry runtimeRegistry;
    private final OperationalSignalService signals;
    private final ExecutionNodeService nodeService;
    private final NodeCommandRepository nodeCommands;
    private final ObjectMapper mapper;

    public OperationEventService(OperationEventRepository repository,
                                 AgentRepository agentRepository,
                                 AgentRuntimeRegistry runtimeRegistry,
                                 OperationalSignalService signals,
                                 ExecutionNodeService nodeService,
                                 NodeCommandRepository nodeCommands,
                                 ObjectMapper mapper) {
        this.repository = repository;
        this.agentRepository = agentRepository;
        this.runtimeRegistry = runtimeRegistry;
        this.signals = signals;
        this.nodeService = nodeService;
        this.nodeCommands = nodeCommands;
        this.mapper = mapper;
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
        var deliverable = repository.findTop50ByStatusInOrderByCreatedAtAsc(List.of(
                OperationEventEntity.Status.PENDING,
                OperationEventEntity.Status.FAILED,
                OperationEventEntity.Status.QUEUED));
        for (OperationEventEntity event : deliverable) {
            if (event.getAttempts() >= MAX_ATTEMPTS) continue;
            if (event.getStatus() == OperationEventEntity.Status.FAILED
                    && event.getCodexQueuedSubmissionId() != null
                    && event.getCodexQueuedSubmissionId().startsWith("node-command:")) {
                // A terminal remote command failure may be ambiguous after node crash. Fail closed instead of
                // creating another command that could duplicate a Codex turn.
                continue;
            }
            try {
                if (event.getStatus() == OperationEventEntity.Status.QUEUED) {
                    reconcileQueued(event);
                    continue;
                }
                deliver(event);
            } catch (RuntimeException error) {
                event.failed(bounded(error.getMessage()));
                repository.save(event);
            }
        }
    }

    private void deliver(OperationEventEntity event) {
        AgentEntity target = resolveTarget(event);
        if (target.getStatus() == AgentStatus.STOPPED || target.getStatus() == AgentStatus.FAILED) {
            throw new IllegalStateException("Operational Agent is unavailable: " + target.getStatus());
        }
        if (runtimeSessionId(target) == null || runtimeSessionId(target).isBlank()) {
            throw new IllegalStateException("Operational Agent runtime is not ready");
        }
        String clientMessageId = "agenticform-operation-event:" + event.getId() + ":g" + target.getRuntimeGeneration();
        if (target.getExecutionNodeId() != null) {
            NodeCommandEntity command = nodeService.enqueue(
                    target.getExecutionNodeId(), target.getId(), "DELIVER_MESSAGE", clientMessageId,
                    Map.of(
                            "operationEventId", event.getId().toString(),
                            "runtimeType", runtimeType(target).name(),
                            "runtimeSessionId", runtimeSessionId(target),
                            "clientMessageId", clientMessageId,
                            "prompt", deliveryPrompt(event)));
            event.queued(command.getId());
            repository.save(event);
            if (command.terminal()) reconcileCommand(event, command);
            return;
        }

        RuntimeDispatchReceipt receipt = runtimeRegistry.get(target.getRuntimeType()).dispatch(
                new RuntimeSession(runtimeSessionId(target)), clientMessageId, deliveryPrompt(event));
        event.delivered(receipt.queuedSubmissionId(), receipt.turnId());
        repository.save(event);
    }

    private String runtimeSessionId(AgentEntity agent) {
        return agent.getRuntimeSessionId();
    }

    private RuntimeType runtimeType(AgentEntity agent) {
        return agent.getRuntimeType();
    }

    private void reconcileQueued(OperationEventEntity event) {
        UUID commandId = event.queuedNodeCommandId();
        if (commandId == null) {
            event.failed("Operation event has invalid queued node command reference");
            repository.save(event);
            return;
        }
        NodeCommandEntity command = nodeCommands.findById(commandId).orElse(null);
        if (command == null) {
            event.failed("Operation event node command no longer exists");
            repository.save(event);
            return;
        }
        if (!command.terminal()) return;
        reconcileCommand(event, command);
    }

    private void reconcileCommand(OperationEventEntity event, NodeCommandEntity command) {
        if (command.getStatus() != NodeCommandEntity.Status.SUCCEEDED) {
            event.failed(bounded(command.getLastError()));
            repository.save(event);
            return;
        }
        JsonNode result = read(command.getResultJson());
        event.delivered(result.path("queuedSubmissionId").asText(null), result.path("turnId").asText(null));
        repository.save(event);
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

    private JsonNode read(String json) {
        try {
            return mapper.readTree(json == null || json.isBlank() ? "{}" : json);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to parse durable operation event delivery result", error);
        }
    }

    private String bounded(String value) {
        if (value == null || value.isBlank()) return "unknown error";
        return value.length() > 1500 ? value.substring(0, 1500) + "…" : value;
    }
}
