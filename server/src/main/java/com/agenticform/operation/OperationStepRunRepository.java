package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationStepRunRepository extends JpaRepository<OperationStepRunEntity, UUID> {
    List<OperationStepRunEntity> findAllByOperationRunIdOrderByPosition(UUID operationRunId);
    Optional<OperationStepRunEntity> findByOperationRunIdAndPosition(UUID operationRunId, int position);
}
