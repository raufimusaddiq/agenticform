package com.agenticform.operation;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "operational_services")
public class OperationalServiceEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "environment_id", nullable = false)
    private UUID environmentId;

    @Column(nullable = false, length = 64)
    private String key;

    @Column(name = "display_name", nullable = false, length = 128)
    private String displayName;

    @Column(name = "health_url", columnDefinition = "text")
    private String healthUrl;

    @Column(name = "readiness_url", columnDefinition = "text")
    private String readinessUrl;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected OperationalServiceEntity() {}

    public OperationalServiceEntity(UUID projectId, UUID environmentId, String key, String displayName,
                                    String healthUrl, String readinessUrl) {
        this.projectId = projectId;
        this.environmentId = environmentId;
        this.key = key;
        this.displayName = displayName;
        this.healthUrl = healthUrl;
        this.readinessUrl = readinessUrl;
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public void update(String displayName, String healthUrl, String readinessUrl, boolean enabled) {
        this.displayName = displayName;
        this.healthUrl = healthUrl;
        this.readinessUrl = readinessUrl;
        this.enabled = enabled;
    }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public UUID getEnvironmentId() { return environmentId; }
    public String getKey() { return key; }
    public String getDisplayName() { return displayName; }
    public String getHealthUrl() { return healthUrl; }
    public String getReadinessUrl() { return readinessUrl; }
    public boolean isEnabled() { return enabled; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
