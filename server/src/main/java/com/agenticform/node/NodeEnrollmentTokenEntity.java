package com.agenticform.node;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "node_enrollment_tokens")
public class NodeEnrollmentTokenEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "token_hash", nullable = false, unique = true, length = 64)
    private String tokenHash;

    @Column(name = "requested_name", nullable = false, length = 128)
    private String requestedName;

    @Enumerated(EnumType.STRING)
    @Column(name = "requested_trust_level", nullable = false, length = 32)
    private NodeTrustLevel requestedTrustLevel;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "used_at")
    private Instant usedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected NodeEnrollmentTokenEntity() {}

    public NodeEnrollmentTokenEntity(String tokenHash, String requestedName,
                                     NodeTrustLevel requestedTrustLevel, Instant expiresAt) {
        this.tokenHash = tokenHash;
        this.requestedName = requestedName;
        this.requestedTrustLevel = requestedTrustLevel;
        this.expiresAt = expiresAt;
    }

    @PrePersist
    void onCreate() { createdAt = Instant.now(); }

    public boolean usable(Instant now) {
        return usedAt == null && expiresAt.isAfter(now);
    }

    public void consume() {
        if (!usable(Instant.now())) throw new IllegalStateException("Enrollment token is expired or already used");
        usedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public String getTokenHash() { return tokenHash; }
    public String getRequestedName() { return requestedName; }
    public NodeTrustLevel getRequestedTrustLevel() { return requestedTrustLevel; }
    public Instant getExpiresAt() { return expiresAt; }
    public Instant getUsedAt() { return usedAt; }
    public Instant getCreatedAt() { return createdAt; }
}
