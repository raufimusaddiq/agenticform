package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface OperationRunRepository extends JpaRepository<OperationRunEntity, UUID> {
    List<OperationRunEntity> findAllByOrderByCreatedAtDesc();
    List<OperationRunEntity> findAllByProjectIdOrderByCreatedAtDesc(UUID projectId);
    List<OperationRunEntity> findAllByStatusIn(Collection<OperationRunEntity.Status> statuses);
}
