package com.agenticform.node;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface NodeCommandRepository extends JpaRepository<NodeCommandEntity, UUID> {
    Optional<NodeCommandEntity> findByIdempotencyKey(String idempotencyKey);
    List<NodeCommandEntity> findAllByNodeIdOrderByCreatedAtAsc(UUID nodeId);
}
