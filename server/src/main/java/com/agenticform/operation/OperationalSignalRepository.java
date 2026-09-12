package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationalSignalRepository extends JpaRepository<OperationalSignalEntity, UUID> {
    Optional<OperationalSignalEntity> findFirstByProjectIdAndFingerprintAndStatusInOrderByLastSeenAtDesc(
            UUID projectId, String fingerprint, Collection<OperationalSignalEntity.Status> statuses);
    List<OperationalSignalEntity> findAllByProjectIdOrderByLastSeenAtDesc(UUID projectId);
    List<OperationalSignalEntity> findAllByProjectIdAndStatusOrderByLastSeenAtDesc(
            UUID projectId, OperationalSignalEntity.Status status);
}
