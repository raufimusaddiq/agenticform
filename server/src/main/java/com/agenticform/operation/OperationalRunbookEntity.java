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
@Table(name = "operational_runbooks")
public class OperationalRunbookEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "environment_id", nullable = false)
    private UUID environmentId;

    @Column(nullable = false, length = 64)
    private String key;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(nullable = false, length = 128)
    private String action;

    @Column(nullable = false, columnDefinition = "text")
    private String description;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(nullable = false)
    private int version = 1;

    @Column(name = "definition_json", nullable = false, columnDefinition = "text")
    private String definitionJson;

    /** MANUAL for hand-registered runbooks, REPOSITORY_MANIFEST for discovered ones. */
    @Column(nullable = false, length = 32)
    private String source = "MANUAL";

    @Column(name = "source_repository", length = 256)
    private String sourceRepository;

    @Column(name = "source_commit", length = 64)
    private String sourceCommit;

    @Column(name = "source_path", length = 256)
    private String sourcePath;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected OperationalRunbookEntity() {}

    public OperationalRunbookEntity(UUID projectId, UUID environmentId, String key, String name,
                                    String action, String description, String definitionJson) {
        this.projectId = projectId;
        this.environmentId = environmentId;
        this.key = key;
        this.name = name;
        this.action = action;
        this.description = description;
        this.definitionJson = definitionJson;
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public void update(String name, String action, String description, String definitionJson, boolean enabled) {
        this.name = name;
        this.action = action;
        this.description = description;
        this.definitionJson = definitionJson;
        this.enabled = enabled;
        this.version++;
    }

    /**
     * Records where a discovered runbook came from. Provenance is only written by
     * repository discovery; manual runbooks keep their MANUAL source.
     */
    public void recordSource(String source, String sourceRepository, String sourceCommit, String sourcePath) {
        this.source = source;
        this.sourceRepository = sourceRepository;
        this.sourceCommit = sourceCommit;
        this.sourcePath = sourcePath;
    }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public UUID getEnvironmentId() { return environmentId; }
    public String getKey() { return key; }
    public String getName() { return name; }
    public String getAction() { return action; }
    public String getDescription() { return description; }
    public boolean isEnabled() { return enabled; }
    public int getVersion() { return version; }
    public String getDefinitionJson() { return definitionJson; }
    public String getSource() { return source; }
    public String getSourceRepository() { return sourceRepository; }
    public String getSourceCommit() { return sourceCommit; }
    public String getSourcePath() { return sourcePath; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
