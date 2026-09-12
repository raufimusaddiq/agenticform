package com.agenticform.operation;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "operational_signals")
public class OperationalSignalEntity {
    public enum Status { OPEN, CORRELATED, RESOLVED, SUPPRESSED }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 64)
    private OperationalSignalSource source;

    @Column(name = "signal_type", nullable = false, length = 128)
    private String signalType;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private OperationalSeverity severity;

    @Column(nullable = false, length = 255)
    private String fingerprint;

    @Column(name = "correlation_key", length = 255)
    private String correlationKey;

    @Column(name = "payload_json", nullable = false, columnDefinition = "text")
    private String payloadJson;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status = Status.OPEN;

    @Column(name = "occurrence_count", nullable = false)
    private int occurrenceCount = 1;

    @Column(name = "first_seen_at", nullable = false)
    private Instant firstSeenAt;

    @Column(name = "last_seen_at", nullable = false)
    private Instant lastSeenAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected OperationalSignalEntity() {}

    public OperationalSignalEntity(UUID projectId, OperationalSignalSource source, String signalType,
                                   OperationalSeverity severity, String fingerprint, String correlationKey,
                                   String payloadJson, Instant observedAt) {
        this.projectId = projectId;
        this.source = source;
        this.signalType = signalType;
        this.severity = severity;
        this.fingerprint = fingerprint;
        this.correlationKey = correlationKey;
        this.payloadJson = payloadJson == null ? "{}" : payloadJson;
        this.firstSeenAt = observedAt;
        this.lastSeenAt = observedAt;
    }

    @PrePersist
    void onCreate() {
        createdAt = updatedAt = Instant.now();
        if (firstSeenAt == null) firstSeenAt = createdAt;
        if (lastSeenAt == null) lastSeenAt = firstSeenAt;
    }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public void observe(OperationalSeverity severity, String payloadJson, Instant observedAt) {
        occurrenceCount++;
        if (severity != null && severity.higherThan(this.severity)) this.severity = severity;
        if (payloadJson != null && !payloadJson.isBlank()) this.payloadJson = payloadJson;
        lastSeenAt = observedAt == null ? Instant.now() : observedAt;
    }

    public void correlated() { if (status == Status.OPEN) status = Status.CORRELATED; }
    public void resolve() { status = Status.RESOLVED; }
    public void suppress() { status = Status.SUPPRESSED; }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public OperationalSignalSource getSource() { return source; }
    public String getSignalType() { return signalType; }
    public OperationalSeverity getSeverity() { return severity; }
    public String getFingerprint() { return fingerprint; }
    public String getCorrelationKey() { return correlationKey; }
    public String getPayloadJson() { return payloadJson; }
    public Status getStatus() { return status; }
    public int getOccurrenceCount() { return occurrenceCount; }
    public Instant getFirstSeenAt() { return firstSeenAt; }
    public Instant getLastSeenAt() { return lastSeenAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
