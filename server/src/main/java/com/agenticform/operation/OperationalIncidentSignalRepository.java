package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface OperationalIncidentSignalRepository extends JpaRepository<OperationalIncidentSignalEntity, OperationalIncidentSignalId> {
    List<OperationalIncidentSignalEntity> findAllByIncidentId(UUID incidentId);
    boolean existsByIncidentIdAndSignalId(UUID incidentId, UUID signalId);
}
