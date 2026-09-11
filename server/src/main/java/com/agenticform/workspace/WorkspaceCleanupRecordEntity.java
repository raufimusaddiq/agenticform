package com.agenticform.workspace;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "workspace_cleanup_records")
public class WorkspaceCleanupRecordEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "agent_id")
    private UUID agentId;

    @Column(name = "working_directory", nullable = false, columnDefinition = "text")
    private String workingDirectory;

    @Column(length = 255)
    private String branch;

    @Column(nullable = false, length = 32)
    private String outcome;

    @Column(nullable = false, columnDefinition = "text")
    private String reason;

    @Column(name = "freed_bytes")
    private Long freedBytes;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected WorkspaceCleanupRecordEntity() {}

    public WorkspaceCleanupRecordEntity(UUID projectId, UUID agentId, String workingDirectory,
                                        String branch, String outcome, String reason, Long freedBytes) {
        this.projectId = projectId;
        this.agentId = agentId;
        this.workingDirectory = workingDirectory;
        this.branch = branch;
        this.outcome = outcome;
        this.reason = reason;
        this.freedBytes = freedBytes;
    }

    @PrePersist
    void onCreate() { createdAt = Instant.now(); }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public UUID getAgentId() { return agentId; }
    public String getWorkingDirectory() { return workingDirectory; }
    public String getBranch() { return branch; }
    public String getOutcome() { return outcome; }
    public String getReason() { return reason; }
    public Long getFreedBytes() { return freedBytes; }
    public Instant getCreatedAt() { return createdAt; }
}
