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
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class OperationalIncidentWakeService {
    private static final int MAX_ATTEMPTS = 5;

    private final OperationalIncidentRepository incidents;
    private final AgentRepository agents;
    private final AgentRuntimeRegistry runtimeRegistry;
    private final ExecutionNodeService nodeService;
    private final NodeCommandRepository commands;
    private final ObjectMapper mapper;

    public OperationalIncidentWakeService(OperationalIncidentRepository incidents,
                                          AgentRepository agents,
                                          AgentRuntimeRegistry runtimeRegistry,
                                          ExecutionNodeService nodeService,
                                          NodeCommandRepository commands,
                                          ObjectMapper mapper) {
        this.incidents = incidents;
        this.agents = agents;
        this.runtimeRegistry = runtimeRegistry;
        this.nodeService = nodeService;
        this.commands = commands;
        this.mapper = mapper;
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.operational-intelligence-delay-ms:2000}")
    public synchronized void deliverPending() {
        List<OperationalIncidentEntity> rows = incidents.findTop50ByWakeStatusInOrderByUpdatedAtAsc(List.of(
                OperationalIncidentEntity.WakeStatus.PENDING,
                OperationalIncidentEntity.WakeStatus.FAILED,
                OperationalIncidentEntity.WakeStatus.QUEUED));
        for (OperationalIncidentEntity incident : rows) {
            if (incident.terminal() || incident.getWakeAttempts() >= MAX_ATTEMPTS) continue;
            if (incident.getWakeStatus() == OperationalIncidentEntity.WakeStatus.FAILED
                    && incident.getWakeCommandId() != null) {
                // The node command reached a terminal failure. It may have crossed the side-effect boundary
                // before a crash, so only an explicit operator retry may create another command.
                continue;
            }
            try {
                if (incident.getWakeStatus() == OperationalIncidentEntity.WakeStatus.QUEUED
                        && reconcileQueued(incident)) continue;
                deliver(incident);
            } catch (RuntimeException error) {
                incident.wakeFailed(bounded(error.getMessage()));
                incidents.save(incident);
            }
        }
    }

    @Transactional
    public void completeNodeDelivery(NodeCommandEntity command, boolean success, String resultJson, String error) {
        JsonNode payload = read(command.getPayloadJson());
        String incidentId = payload.path("incidentId").asText(null);
        if (incidentId == null || incidentId.isBlank()) return;
        OperationalIncidentEntity incident = incidents.findById(UUID.fromString(incidentId)).orElse(null);
        if (incident == null || incident.terminal()) return;
        if (incident.getOperationalAgentId() != null && !incident.getOperationalAgentId().equals(command.getAgentId())) return;
        if (!success) {
            incident.wakeFailed(bounded(error));
        } else {
            JsonNode result = read(resultJson);
            incident.delivered(result.path("queuedSubmissionId").asText(null), result.path("turnId").asText(null));
        }
        incidents.save(incident);
    }

    private boolean reconcileQueued(OperationalIncidentEntity incident) {
        if (incident.getWakeCommandId() == null) {
            incident.retryWake();
            incidents.save(incident);
            return false;
        }
        NodeCommandEntity command = commands.findById(incident.getWakeCommandId()).orElse(null);
        if (command == null) {
            incident.wakeFailed("Incident wake command no longer exists");
            incidents.save(incident);
            return true;
        }
        if (!command.terminal()) return true;
        if (command.getStatus() == NodeCommandEntity.Status.SUCCEEDED) {
            completeNodeDelivery(command, true, command.getResultJson(), null);
        } else {
            completeNodeDelivery(command, false, command.getResultJson(), command.getLastError());
        }
        return true;
    }

    private void deliver(OperationalIncidentEntity incident) {
        AgentEntity target = resolveOperationalAgent(incident);
        if (target.getStatus() == AgentStatus.STOPPED || target.getStatus() == AgentStatus.FAILED) {
            throw new IllegalStateException("Operational Agent is unavailable: " + target.getStatus());
        }
        if (runtimeSessionId(target) == null || runtimeSessionId(target).isBlank()) {
            throw new IllegalStateException("Operational Agent runtime is not ready");
        }
        incident.setOperationalAgentId(target.getId());
        String clientMessageId = "agenticform-incident:" + incident.getId() + ":g" + target.getRuntimeGeneration();
        if (target.getExecutionNodeId() != null) {
            String commandKey = clientMessageId + ":attempt:" + (incident.getWakeAttempts() + 1);
            NodeCommandEntity command = nodeService.enqueue(
                    target.getExecutionNodeId(), target.getId(), "DELIVER_MESSAGE",
                    commandKey, Map.of(
                            "incidentId", incident.getId().toString(),
                            "runtimeType", runtimeType(target).name(),
                            "runtimeSessionId", runtimeSessionId(target),
                            "threadId", runtimeSessionId(target),
                            "clientMessageId", clientMessageId,
                            "prompt", prompt(incident)));
            incident.queued(command.getId());
            incidents.save(incident);
            if (command.terminal()) {
                completeNodeDelivery(command, command.getStatus() == NodeCommandEntity.Status.SUCCEEDED,
                        command.getResultJson(), command.getLastError());
            }
            return;
        }

        RuntimeDispatchReceipt receipt = runtimeRegistry.get(target.getRuntimeType()).dispatch(
                new RuntimeSession(runtimeSessionId(target)), clientMessageId, prompt(incident));
        incident.delivered(receipt.queuedSubmissionId(), receipt.turnId());
        incidents.save(incident);
    }

    private String runtimeSessionId(AgentEntity agent) {
        String sessionId = agent.getRuntimeSessionId();
        return sessionId == null || sessionId.isBlank() ? agent.getCodexThreadId() : sessionId;
    }

    private RuntimeType runtimeType(AgentEntity agent) {
        return agent.getRuntimeType() == null ? RuntimeType.CODEX : agent.getRuntimeType();
    }

    private AgentEntity resolveOperationalAgent(OperationalIncidentEntity incident) {
        if (incident.getOperationalAgentId() != null) {
            AgentEntity target = agents.findById(incident.getOperationalAgentId()).orElse(null);
            if (target != null && target.getRole() == AgentRole.OPERATIONAL) return target;
        }
        return agents.findByProjectIdAndRole(incident.getProjectId(), AgentRole.OPERATIONAL)
                .orElseThrow(() -> new IllegalStateException("Project has no Operational Agent for incident response"));
    }

    private String prompt(OperationalIncidentEntity incident) {
        return """
                Agenticform operational incident requires investigation.

                Incident ID: %s
                Type: %s
                Severity: %s
                Status: %s
                Summary: %s
                Suspected change: %s

                Use agenticform.get_incident to inspect correlated durable signals and evidence. Use read-only operational tools
                before deciding on mitigation. You may coordinate other project agents with send_message/broadcast_message.
                Any real operational effect must still go through request_operation and deterministic policy/runbooks.
                Update the incident to INVESTIGATING or MITIGATING while working, and RESOLVED only after evidence proves recovery.
                """.formatted(incident.getId(), incident.getIncidentType(), incident.getSeverity(), incident.getStatus(),
                incident.getSummary(), incident.getSuspectedChange() == null ? "unknown" : incident.getSuspectedChange());
    }

    private JsonNode read(String json) {
        try {
            return mapper.readTree(json == null || json.isBlank() ? "{}" : json);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to parse durable incident delivery payload", error);
        }
    }

    private String bounded(String value) {
        if (value == null || value.isBlank()) return "unknown delivery error";
        return value.length() > 1500 ? value.substring(0, 1500) + "…" : value;
    }
}
