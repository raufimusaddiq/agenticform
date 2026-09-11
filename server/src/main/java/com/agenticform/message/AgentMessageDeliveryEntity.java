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
        status = AgentMessageStatus.CREATED;
        codexQueuedSubmissionId = "node-command:" + nodeCommandId;
        codexTurnId = null;
        lastError = null;
    }

    public void markDispatched(String queuedSubmissionId, String turnId) {
        attemptCount++;
        status = AgentMessageStatus.DISPATCHED;
        codexQueuedSubmissionId = queuedSubmissionId;
        codexTurnId = turnId;
        lastError = null;
    }

    public void markFailed(String error) {
        attemptCount++;
        status = AgentMessageStatus.FAILED;
        lastError = error;
    }

    public void resetForRetry() {
        status = AgentMessageStatus.CREATED;
        lastError = null;
    }

    public UUID getId() { return id; }
    public UUID getMessageId() { return messageId; }
    public UUID getToAgentId() { return toAgentId; }
    public AgentMessageStatus getStatus() { return status; }
    public int getAttemptCount() { return attemptCount; }
    public String getCodexQueuedSubmissionId() { return codexQueuedSubmissionId; }
    public String getCodexTurnId() { return codexTurnId; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
