package com.agenticform.message;

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
@Table(name = "agent_message_deliveries")
public class AgentMessageDeliveryEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "message_id", nullable = false)
    private UUID messageId;

    @Column(name = "to_agent_id", nullable = false)
    private UUID toAgentId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private AgentMessageStatus status = AgentMessageStatus.CREATED;

    @Column(name = "attempt_count", nullable = false)
    private int attemptCount;

    @Column(name = "queued_submission_id")
    private String queuedSubmissionId;

    @Column(name = "turn_id")
    private String turnId;

    @Column(name = "last_error", columnDefinition = "text")
    private String lastError;

    @Column(name = "processing_started_at")
    private Instant processingStartedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected AgentMessageDeliveryEntity() {}

    public AgentMessageDeliveryEntity(UUID messageId, UUID toAgentId) {
        this.messageId = messageId;
        this.toAgentId = toAgentId;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public void markQueuedOnNode(String nodeCommandId) {
        status = AgentMessageStatus.QUEUED;
        queuedSubmissionId = "node-command:" + nodeCommandId;
        turnId = null;
        processingStartedAt = null;
        completedAt = null;
        lastError = null;
    }

    public void markDispatched(String queuedSubmissionId, String turnId) {
        attemptCount++;
        status = turnId == null || turnId.isBlank() ? AgentMessageStatus.DISPATCHED : AgentMessageStatus.PROCESSING;
        this.queuedSubmissionId = queuedSubmissionId;
        this.turnId = turnId;
        processingStartedAt = turnId == null || turnId.isBlank() ? null : Instant.now();
        completedAt = null;
        lastError = null;
    }

    public void markProcessing(String turnId) {
        if (status == AgentMessageStatus.COMPLETED || status == AgentMessageStatus.FAILED) return;
        status = AgentMessageStatus.PROCESSING;
        if (turnId != null && !turnId.isBlank()) this.turnId = turnId;
        if (processingStartedAt == null) processingStartedAt = Instant.now();
        lastError = null;
    }

    public void markCompleted() {
        status = AgentMessageStatus.COMPLETED;
        if (processingStartedAt == null) processingStartedAt = Instant.now();
        completedAt = Instant.now();
        lastError = null;
    }

    public void markFailed(String error) {
        attemptCount++;
        status = AgentMessageStatus.FAILED;
        completedAt = Instant.now();
        lastError = error;
    }

    public void markProcessingFailed(String error) {
        status = AgentMessageStatus.FAILED;
        completedAt = Instant.now();
        lastError = error;
    }

    public void resetForRetry() {
        status = AgentMessageStatus.CREATED;
        turnId = null;
        processingStartedAt = null;
        completedAt = null;
        lastError = null;
    }

    public UUID getId() { return id; }
    public UUID getMessageId() { return messageId; }
    public UUID getToAgentId() { return toAgentId; }
    public AgentMessageStatus getStatus() { return status; }
    public int getAttemptCount() { return attemptCount; }
    public String getQueuedSubmissionId() { return queuedSubmissionId; }
    public String getTurnId() { return turnId; }
    public String getLastError() { return lastError; }
    public Instant getProcessingStartedAt() { return processingStartedAt; }
    public Instant getCompletedAt() { return completedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
