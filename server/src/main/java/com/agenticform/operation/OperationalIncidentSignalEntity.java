package com.agenticform.operation;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@IdClass(OperationalIncidentSignalId.class)
@Table(name = "operational_incident_signals")
public class OperationalIncidentSignalEntity {
    @Id
    @Column(name = "incident_id", nullable = false)
    private UUID incidentId;

    @Id
    @Column(name = "signal_id", nullable = false)
    private UUID signalId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected OperationalIncidentSignalEntity() {}

    public OperationalIncidentSignalEntity(UUID incidentId, UUID signalId) {
        this.incidentId = incidentId;
        this.signalId = signalId;
    }

    public UUID getIncidentId() { return incidentId; }
    public UUID getSignalId() { return signalId; }
    public Instant getCreatedAt() { return createdAt; }
}
