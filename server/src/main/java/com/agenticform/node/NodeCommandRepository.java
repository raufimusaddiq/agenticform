package com.agenticform.node;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public interface NodeCommandRepository extends JpaRepository<NodeCommandEntity, UUID> {
    Optional<NodeCommandEntity> findByIdempotencyKey(String idempotencyKey);

    @Query(value = """
            SELECT * FROM node_commands
            WHERE node_id = :nodeId
              AND (status = 'QUEUED' OR (status = 'LEASED' AND lease_until < :now))
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
            """, nativeQuery = true)
    Optional<NodeCommandEntity> findNextAvailableForUpdate(@Param("nodeId") UUID nodeId,
                                                            @Param("now") Instant now);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select command from NodeCommandEntity command where command.id = :id")
    Optional<NodeCommandEntity> findByIdForUpdate(@Param("id") UUID id);
}
