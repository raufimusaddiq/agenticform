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
@Table(name = "operation_events")
public class OperationEventEntity {
    public enum Status { PENDING, DISPATCHED, FAILED }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "operation_run_id", nullable = false)
    private UUID operationRunId;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "target_agent_id")
    private UUID targetAgentId;

    @Column(name = "event_type", nullable = false, length = 64)
    private String eventType;

    @Column(nullable = false, columnDefinition = "text")
    private String payload;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status;

    @Column(nullable = false)
    private int attempts;

    @Column(name = "codex_queued_submission_id")
    private String codexQueuedSubmissionId;

    @Column(name = "codex_turn_id")
    private String codexTurnId;

    @Column(name = "last_error", columnDefinition = "text")
    private String lastError;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected OperationEventEntity() {}

    public OperationEventEntity(UUID operationRunId, UUID projectId, UUID targetAgentId,
                                String eventType, String payload) {
        this.operationRunId = operationRunId;
        this.projectId = projectId;
        this.targetAgentId = targetAgentId;
        this.eventType = eventType;
        this.payload = payload;
        this.status = Status.PENDING;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public void delivered(String queuedSubmissionId, String turnId) {
        this.status = Status.DISPATCHED;
        this.codexQueuedSubmissionId = queuedSubmissionId;
        this.codexTurnId = turnId;
        this.lastError = null;
        this.attempts++;
    }

    public void failed(String error) {
        this.status = Status.FAILED;
        this.lastError = error;
        this.attempts++;
    }

    public void retry() { this.status = Status.PENDING; }
    public void setTargetAgentId(UUID targetAgentId) { this.targetAgentId = targetAgentId; }

    public UUID getId() { return id; }
    public UUID getOperationRunId() { return operationRunId; }
    public UUID getProjectId() { return projectId; }
    public UUID getTargetAgentId() { return targetAgentId; }
    public String getEventType() { return eventType; }
    public String getPayload() { return payload; }
    public Status getStatus() { return status; }
    public int getAttempts() { return attempts; }
    public String getCodexQueuedSubmissionId() { return codexQueuedSubmissionId; }
    public String getCodexTurnId() { return codexTurnId; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
