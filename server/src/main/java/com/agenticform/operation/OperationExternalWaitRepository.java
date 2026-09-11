package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationExternalWaitRepository extends JpaRepository<OperationExternalWaitEntity, UUID> {
    List<OperationExternalWaitEntity> findAllByStatusOrderByCreatedAtAsc(OperationExternalWaitEntity.Status status);
    Optional<OperationExternalWaitEntity> findByStepRunId(UUID stepRunId);
}
