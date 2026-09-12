package com.agenticform.node;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.UUID;

public interface NodeRequestNonceRepository extends JpaRepository<NodeRequestNonceEntity, UUID> {
    @Modifying
    @Query(value = """
            INSERT INTO node_request_nonces (id, node_id, nonce, expires_at, created_at)
            VALUES (:id, :nodeId, :nonce, :expiresAt, :createdAt)
            ON CONFLICT (node_id, nonce) DO NOTHING
            """, nativeQuery = true)
    int insertIfAbsent(@Param("id") UUID id,
                       @Param("nodeId") UUID nodeId,
                       @Param("nonce") String nonce,
                       @Param("expiresAt") Instant expiresAt,
                       @Param("createdAt") Instant createdAt);

    long deleteByExpiresAtBefore(Instant cutoff);
}
