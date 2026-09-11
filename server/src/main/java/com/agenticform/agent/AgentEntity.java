package com.agenticform.agent;

import com.agenticform.workspace.WorkspaceMode;
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
@Table(name = "agents")
public class AgentEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, columnDefinition = "text")
    private String responsibility;

    @Column(name = "codex_thread_id", nullable = false, unique = true)
    private String codexThreadId;

    @Enumerated(EnumType.STRING)
    @Column(name = "workspace_mode", nullable = false)
    private WorkspaceMode workspaceMode;

    @Column(name = "source_directory", nullable = false)
    private String sourceDirectory;

    @Column(name = "working_directory", nullable = false)
    private String workingDirectory;

    private String branch;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private AgentStatus status;

    @Enumerated(EnumType.STRING)
    @Column(name = "queue_mode", nullable = false)
    private AgentQueueMode queueMode;

    @Column(name = "active_task_id")
    private UUID activeTaskId;

    @Column(name = "active_turn_id")
    private String activeTurnId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected AgentEntity() {}

    public AgentEntity(UUID projectId, String name, String responsibility, String codexThreadId,
                       WorkspaceMode workspaceMode, String sourceDirectory, String workingDirectory,
                       String branch, AgentQueueMode queueMode) {
        this.projectId = projectId;
        this.name = name;
        this.responsibility = responsibility;
        this.codexThreadId = codexThreadId;
        this.workspaceMode = workspaceMode;
        this.sourceDirectory = sourceDirectory;
        this.workingDirectory = workingDirectory;
        this.branch = branch;
        this.queueMode = queueMode;
        this.status = AgentStatus.IDLE;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public String getName() { return name; }
    public String getResponsibility() { return responsibility; }
    public String getCodexThreadId() { return codexThreadId; }
    public WorkspaceMode getWorkspaceMode() { return workspaceMode; }
    public String getSourceDirectory() { return sourceDirectory; }
    public String getWorkingDirectory() { return workingDirectory; }
    public String getBranch() { return branch; }
    public AgentStatus getStatus() { return status; }
    public AgentQueueMode getQueueMode() { return queueMode; }
    public UUID getActiveTaskId() { return activeTaskId; }
    public String getActiveTurnId() { return activeTurnId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void setStatus(AgentStatus status) { this.status = status; }
    public void setQueueMode(AgentQueueMode queueMode) { this.queueMode = queueMode; }
    public void setActiveTaskId(UUID activeTaskId) { this.activeTaskId = activeTaskId; }
    public void setActiveTurnId(String activeTurnId) { this.activeTurnId = activeTurnId; }
}
