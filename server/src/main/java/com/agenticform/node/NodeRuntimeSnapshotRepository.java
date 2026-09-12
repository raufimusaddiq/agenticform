package com.agenticform.node;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface NodeRuntimeSnapshotRepository extends JpaRepository<NodeRuntimeSnapshotEntity, UUID> {
    Optional<NodeRuntimeSnapshotEntity> findByNodeIdAndAgentId(UUID nodeId, UUID agentId);
    List<NodeRuntimeSnapshotEntity> findAllByNodeId(UUID nodeId);
    List<NodeRuntimeSnapshotEntity> findAllByAgentIdOrderByObservedAtDesc(UUID agentId);
}
