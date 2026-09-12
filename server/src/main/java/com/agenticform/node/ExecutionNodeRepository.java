package com.agenticform.node;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ExecutionNodeRepository extends JpaRepository<ExecutionNodeEntity, UUID> {
    Optional<ExecutionNodeEntity> findByName(String name);
    Optional<ExecutionNodeEntity> findByFingerprint(String fingerprint);
    List<ExecutionNodeEntity> findAllByStatusOrderByName(ExecutionNodeStatus status);
    List<ExecutionNodeEntity> findAllByStatusInOrderByName(Collection<ExecutionNodeStatus> statuses);
}
