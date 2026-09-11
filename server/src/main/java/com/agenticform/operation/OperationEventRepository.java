package com.agenticform.operation;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationEventRepository extends JpaRepository<OperationEventEntity, UUID> {
    List<OperationEventEntity> findTop50ByStatusInOrderByCreatedAtAsc(Collection<OperationEventEntity.Status> statuses);
    Optional<OperationEventEntity> findByOperationRunIdAndEventType(UUID operationRunId, String eventType);
}
