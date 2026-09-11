package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationalServiceRepository extends JpaRepository<OperationalServiceEntity, UUID> {
    List<OperationalServiceEntity> findAllByProjectIdOrderByEnvironmentIdAscKeyAsc(UUID projectId);
    List<OperationalServiceEntity> findAllByEnvironmentIdOrderByKey(UUID environmentId);
    Optional<OperationalServiceEntity> findByEnvironmentIdAndKey(UUID environmentId, String key);
    boolean existsByEnvironmentIdAndKey(UUID environmentId, String key);
}
