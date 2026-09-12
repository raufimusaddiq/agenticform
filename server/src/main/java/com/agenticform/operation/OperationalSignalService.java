package com.agenticform.operation;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class OperationalSignalService {
    public record SignalInput(UUID projectId, OperationalSignalSource source, String signalType,
                              OperationalSeverity severity, String fingerprint, String correlationKey,
                              Map<String, ?> payload, Instant observedAt) {}
    public record SignalResult(OperationalSignalEntity signal, OperationalIncidentEntity incident) {}

    private static final Collection<OperationalSignalEntity.Status> ACTIVE = List.of(
            OperationalSignalEntity.Status.OPEN, OperationalSignalEntity.Status.CORRELATED);

    private final OperationalSignalRepository repository;
    private final OperationalIncidentService incidents;
    private final ObjectMapper mapper;

    public OperationalSignalService(OperationalSignalRepository repository,
                                    OperationalIncidentService incidents,
                                    ObjectMapper mapper) {
        this.repository = repository;
        this.incidents = incidents;
        this.mapper = mapper;
    }

    @Transactional
    public SignalResult record(SignalInput input) {
        validate(input);
        Instant observedAt = input.observedAt() == null ? Instant.now() : input.observedAt();
        OperationalSeverity severity = input.severity() == null ? OperationalSeverity.WARNING : input.severity();
        String payloadJson = json(input.payload());

        OperationalSignalEntity signal = repository
                .findFirstByProjectIdAndFingerprintAndStatusInOrderByLastSeenAtDesc(
                        input.projectId(), input.fingerprint(), ACTIVE)
                .orElse(null);
        if (signal == null) {
            signal = repository.save(new OperationalSignalEntity(
                    input.projectId(), input.source(), input.signalType(), severity,
                    input.fingerprint(), input.correlationKey(), payloadJson, observedAt));
        } else {
            signal.observe(severity, payloadJson, observedAt);
            signal = repository.save(signal);
        }
        return new SignalResult(signal, incidents.correlate(signal));
    }

    @Transactional
    public SignalResult recover(UUID projectId, OperationalSignalSource source,
                                String failureFingerprint, String correlationKey,
                                Map<String, ?> payload, Instant observedAt) {
        OperationalSignalEntity failure = repository
                .findFirstByProjectIdAndFingerprintAndStatusInOrderByLastSeenAtDesc(
                        projectId, failureFingerprint, ACTIVE)
                .orElse(null);
        if (failure == null) return null;
        failure.resolve();
        repository.save(failure);

        Instant when = observedAt == null ? Instant.now() : observedAt;
        OperationalSignalEntity recovery = repository.save(new OperationalSignalEntity(
                projectId, source, "SERVICE_HEALTH_RECOVERED", OperationalSeverity.INFO,
                failureFingerprint + ":recovered:" + failure.getId(), correlationKey,
                json(payload), when));
        return new SignalResult(recovery, incidents.correlate(recovery));
    }

    public List<OperationalSignalEntity> list(UUID projectId, OperationalSignalEntity.Status status) {
        if (projectId == null) return repository.findAll();
        return status == null
                ? repository.findAllByProjectIdOrderByLastSeenAtDesc(projectId)
                : repository.findAllByProjectIdAndStatusOrderByLastSeenAtDesc(projectId, status);
    }

    private void validate(SignalInput input) {
        if (input.projectId() == null) throw new IllegalArgumentException("Signal projectId is required");
        if (input.source() == null) throw new IllegalArgumentException("Signal source is required");
        if (input.signalType() == null || input.signalType().isBlank()) throw new IllegalArgumentException("Signal type is required");
        if (input.fingerprint() == null || input.fingerprint().isBlank()) throw new IllegalArgumentException("Signal fingerprint is required");
    }

    private String json(Map<String, ?> payload) {
        try {
            return mapper.writeValueAsString(payload == null ? Map.of() : payload);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to serialize operational signal payload", error);
        }
    }
}
