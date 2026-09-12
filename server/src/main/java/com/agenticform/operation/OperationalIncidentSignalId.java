package com.agenticform.operation;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

public class OperationalIncidentSignalId implements Serializable {
    private UUID incidentId;
    private UUID signalId;

    public OperationalIncidentSignalId() {}
    public OperationalIncidentSignalId(UUID incidentId, UUID signalId) {
        this.incidentId = incidentId;
        this.signalId = signalId;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof OperationalIncidentSignalId that)) return false;
        return Objects.equals(incidentId, that.incidentId) && Objects.equals(signalId, that.signalId);
    }

    @Override
    public int hashCode() { return Objects.hash(incidentId, signalId); }
}
