package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationalIncidentRepository extends JpaRepository<OperationalIncidentEntity, UUID> {
    Optional<OperationalIncidentEntity> findFirstByProjectIdAndFingerprintAndStatusInOrderByUpdatedAtDesc(
            UUID projectId, String fingerprint, Collection<OperationalIncidentEntity.Status> statuses);
    List<OperationalIncidentEntity> findAllByProjectIdOrderByUpdatedAtDesc(UUID projectId);
    List<OperationalIncidentEntity> findAllByProjectIdAndStatusOrderByUpdatedAtDesc(
            UUID projectId, OperationalIncidentEntity.Status status);
    List<OperationalIncidentEntity> findTop50ByWakeStatusInOrderByUpdatedAtAsc(
            Collection<OperationalIncidentEntity.WakeStatus> statuses);
}
