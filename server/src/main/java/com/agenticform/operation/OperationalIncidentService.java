package com.agenticform.operation;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class OperationalIncidentService {
    public record IncidentDetail(OperationalIncidentEntity incident, List<OperationalSignalEntity> signals) {}
    private record Rule(String incidentType, OperationalSeverity severity, int threshold, String title) {}

    private static final Collection<OperationalIncidentEntity.Status> ACTIVE = List.of(
            OperationalIncidentEntity.Status.OPEN,
            OperationalIncidentEntity.Status.INVESTIGATING,
            OperationalIncidentEntity.Status.MITIGATING);

    private final OperationalIncidentRepository incidents;
    private final OperationalSignalRepository signals;
    private final OperationalIncidentSignalRepository links;
    private final ObjectMapper mapper;

    public OperationalIncidentService(OperationalIncidentRepository incidents,
                                      OperationalSignalRepository signals,
                                      OperationalIncidentSignalRepository links,
                                      ObjectMapper mapper) {
        this.incidents = incidents;
        this.signals = signals;
        this.links = links;
        this.mapper = mapper;
    }

    @Transactional
    public OperationalIncidentEntity correlate(OperationalSignalEntity signal) {
        Rule rule = rule(signal);
        if (rule == null || signal.getOccurrenceCount() < rule.threshold()) return null;

        String key = signal.getCorrelationKey() == null || signal.getCorrelationKey().isBlank()
                ? signal.getFingerprint() : signal.getCorrelationKey();
        String fingerprint = rule.incidentType() + ":" + key;
        OperationalSeverity severity = signal.getSeverity().higherThan(rule.severity())
                ? signal.getSeverity() : rule.severity();
        String suspectedChange = suspectedChange(signal.getPayloadJson());
        String summary = summary(signal, rule);

        OperationalIncidentEntity incident = incidents
                .findFirstByProjectIdAndFingerprintAndStatusInOrderByUpdatedAtDesc(
                        signal.getProjectId(), fingerprint, ACTIVE)
                .orElse(null);
        if (incident == null) {
            incident = incidents.save(new OperationalIncidentEntity(
                    signal.getProjectId(), rule.incidentType(), severity, fingerprint,
                    rule.title(), summary, suspectedChange, signal.getLastSeenAt()));
        } else {
            incident.observe(severity, summary, suspectedChange, signal.getLastSeenAt());
            incident = incidents.save(incident);
        }

        if (!links.existsByIncidentIdAndSignalId(incident.getId(), signal.getId())) {
            links.save(new OperationalIncidentSignalEntity(incident.getId(), signal.getId()));
        }
        signal.correlated();
        signals.save(signal);
        return incident;
    }

    public List<OperationalIncidentEntity> list(UUID projectId, OperationalIncidentEntity.Status status) {
        if (projectId == null) return incidents.findAll();
        return status == null
                ? incidents.findAllByProjectIdOrderByUpdatedAtDesc(projectId)
                : incidents.findAllByProjectIdAndStatusOrderByUpdatedAtDesc(projectId, status);
    }

    public IncidentDetail detail(UUID incidentId) {
        OperationalIncidentEntity incident = incidents.findById(incidentId)
                .orElseThrow(() -> new NoSuchElementException("Operational incident not found: " + incidentId));
        List<OperationalSignalEntity> rows = links.findAllByIncidentId(incidentId).stream()
                .map(link -> signals.findById(link.getSignalId()).orElse(null))
                .filter(java.util.Objects::nonNull)
                .sorted(java.util.Comparator.comparing(OperationalSignalEntity::getLastSeenAt).reversed())
                .toList();
        return new IncidentDetail(incident, rows);
    }

    @Transactional
    public OperationalIncidentEntity transition(UUID incidentId, OperationalIncidentEntity.Status status,
                                                String summary) {
        OperationalIncidentEntity incident = incidents.findById(incidentId)
                .orElseThrow(() -> new NoSuchElementException("Operational incident not found: " + incidentId));
        incident.transition(status, summary);
        OperationalIncidentEntity saved = incidents.save(incident);
        if (status == OperationalIncidentEntity.Status.RESOLVED || status == OperationalIncidentEntity.Status.SUPPRESSED) {
            for (OperationalIncidentSignalEntity link : links.findAllByIncidentId(incidentId)) {
                signals.findById(link.getSignalId()).ifPresent(signal -> {
                    if (status == OperationalIncidentEntity.Status.RESOLVED) signal.resolve();
                    else signal.suppress();
                    signals.save(signal);
                });
            }
        }
        return saved;
    }

    @Transactional
    public OperationalIncidentEntity retryWake(UUID incidentId) {
        OperationalIncidentEntity incident = incidents.findById(incidentId)
                .orElseThrow(() -> new NoSuchElementException("Operational incident not found: " + incidentId));
        if (incident.terminal()) throw new IllegalStateException("Terminal incident cannot be woken");
        incident.retryWake();
        return incidents.save(incident);
    }

    private Rule rule(OperationalSignalEntity signal) {
        return switch (signal.getSignalType()) {
            case "OPERATION_FAILED" -> new Rule("OPERATION_FAILURE", OperationalSeverity.HIGH, 1, "Operational run failed");
            case "DEPLOY_FAILED", "GITHUB_WORKFLOW_FAILED" -> new Rule("DEPLOYMENT_FAILURE", OperationalSeverity.HIGH, 1, "Deployment or CI workflow failed");
            case "EXECUTION_NODE_OFFLINE_ACTIVE" -> new Rule("EXECUTION_NODE_LOST", OperationalSeverity.HIGH, 1, "Execution node lost with active agents");
            case "SERVICE_HEALTH_FAILURE" -> new Rule("SERVICE_DEGRADED", OperationalSeverity.HIGH, 3, "Service health degraded");
            case "AGENT_RUNTIME_FAILED" -> new Rule("AGENT_RUNTIME_FAILURE", OperationalSeverity.WARNING, 1, "Agent runtime failed");
            case "DISK_CRITICAL" -> new Rule("DISK_CAPACITY_CRITICAL", OperationalSeverity.CRITICAL, 1, "Disk capacity critical");
            case "BACKUP_STALE" -> new Rule("BACKUP_STALE", OperationalSeverity.HIGH, 1, "Backup is stale");
            default -> null;
        };
    }

    private String summary(OperationalSignalEntity signal, Rule rule) {
        return "%s from %s; occurrences=%d; lastSeen=%s".formatted(
                rule.title(), signal.getSource(), signal.getOccurrenceCount(), signal.getLastSeenAt());
    }

    private String suspectedChange(String payloadJson) {
        try {
            JsonNode payload = mapper.readTree(payloadJson == null ? "{}" : payloadJson);
            for (String key : List.of("sha", "headSha", "revision", "commit")) {
                String value = payload.path(key).asText(null);
                if (value != null && !value.isBlank()) return value;
            }
        } catch (Exception ignored) {
            // Payload is evidence, never a reason to make incident correlation fail.
        }
        return null;
    }
}
