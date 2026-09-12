package com.agenticform.node;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "node_request_nonces")
public class NodeRequestNonceEntity {
    @Id
    private UUID id;

    @Column(name = "node_id", nullable = false)
    private UUID nodeId;

    @Column(nullable = false, length = 128)
    private String nonce;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected NodeRequestNonceEntity() {}

    public NodeRequestNonceEntity(UUID nodeId, String nonce, Instant expiresAt) {
        this.id = UUID.randomUUID();
        this.nodeId = nodeId;
        this.nonce = nonce;
        this.expiresAt = expiresAt;
    }

    @PrePersist
    void onCreate() {
        if (id == null) id = UUID.randomUUID();
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getNodeId() { return nodeId; }
    public String getNonce() { return nonce; }
    public Instant getExpiresAt() { return expiresAt; }
    public Instant getCreatedAt() { return createdAt; }
}
