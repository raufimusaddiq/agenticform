package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationalRunbookRepository extends JpaRepository<OperationalRunbookEntity, UUID> {
    List<OperationalRunbookEntity> findAllByProjectIdOrderByKey(UUID projectId);
    Optional<OperationalRunbookEntity> findByProjectIdAndKey(UUID projectId, String key);
    boolean existsByProjectIdAndKey(UUID projectId, String key);
}
