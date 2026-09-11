package com.agenticform.operation;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "operational_environments")
public class OperationalEnvironmentEntity {
    public enum Kind { DEVELOPMENT, STAGING, PRODUCTION, OTHER }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(nullable = false, length = 64)
    private String key;

    @Column(name = "display_name", nullable = false, length = 128)
    private String displayName;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Kind kind;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected OperationalEnvironmentEntity() {}

    public OperationalEnvironmentEntity(UUID projectId, String key, String displayName, Kind kind) {
        this.projectId = projectId;
        this.key = key;
        this.displayName = displayName;
        this.kind = kind;
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public void update(String displayName, Kind kind, boolean enabled) {
        this.displayName = displayName;
        this.kind = kind;
        this.enabled = enabled;
    }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public String getKey() { return key; }
    public String getDisplayName() { return displayName; }
    public Kind getKind() { return kind; }
    public boolean isEnabled() { return enabled; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
