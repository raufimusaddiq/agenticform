package com.agenticform.task;

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
@Table(name = "tasks")
public class TaskEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "assigned_agent_id", nullable = false)
    private UUID assignedAgentId;

    @Column(nullable = false)
    private String title;

    @Column(nullable = false, columnDefinition = "text")
    private String prompt;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private TaskStatus status;

    @Column(nullable = false)
    private int priority;

    @Column(name = "queued_submission_id")
    private String queuedSubmissionId;

    @Column(name = "turn_id")
    private String turnId;

    @Column(name = "last_error", columnDefinition = "text")
    private String lastError;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected TaskEntity() {}

    public TaskEntity(UUID projectId, UUID assignedAgentId, String title, String prompt, int priority) {
        this.projectId = projectId;
        this.assignedAgentId = assignedAgentId;
        this.title = title;
        this.prompt = prompt;
        this.priority = priority;
        this.status = TaskStatus.READY;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public UUID getAssignedAgentId() { return assignedAgentId; }
    public String getTitle() { return title; }
    public String getPrompt() { return prompt; }
    public TaskStatus getStatus() { return status; }
    public int getPriority() { return priority; }
    public String getQueuedSubmissionId() { return queuedSubmissionId; }
    public String getTurnId() { return turnId; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void setStatus(TaskStatus status) { this.status = status; }
    public void setQueuedSubmissionId(String value) { this.queuedSubmissionId = value; }
    public void setTurnId(String value) { this.turnId = value; }
    public void setLastError(String value) { this.lastError = value; }
}
