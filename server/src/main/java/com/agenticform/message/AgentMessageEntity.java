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
@Table(name = "agent_messages")
public class AgentMessageEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "from_agent_id", nullable = false)
    private UUID fromAgentId;

    @Column(name = "to_agent_id")
    private UUID toAgentId;

    @Column(name = "conversation_id", nullable = false)
    private UUID conversationId;

    @Column(name = "reply_to_message_id")
    private UUID replyToMessageId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private AgentMessageType type;

    @Enumerated(EnumType.STRING)
    @Column(name = "audience_type", nullable = false, length = 32)
    private AgentMessageAudienceType audienceType = AgentMessageAudienceType.DIRECT;

    @Column(name = "audience_spec_json", nullable = false, columnDefinition = "text")
    private String audienceSpecJson = "{}";

    @Column(nullable = false)
    private String subject;

    @Column(nullable = false, columnDefinition = "text")
    private String content;

    @Column(name = "hop_count", nullable = false)
    private int hopCount;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private AgentMessageStatus status;

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

    protected AgentMessageEntity() {}

    public AgentMessageEntity(UUID projectId, UUID fromAgentId, UUID toAgentId, UUID conversationId,
                              UUID replyToMessageId, AgentMessageType type, String subject,
                              String content, int hopCount) {
        this(projectId, fromAgentId, toAgentId, conversationId, replyToMessageId, type,
                AgentMessageAudienceType.DIRECT, "{}", subject, content, hopCount);
    }

    public AgentMessageEntity(UUID projectId, UUID fromAgentId, UUID toAgentId, UUID conversationId,
                              UUID replyToMessageId, AgentMessageType type,
                              AgentMessageAudienceType audienceType, String audienceSpecJson,
                              String subject, String content, int hopCount) {
        this.projectId = projectId;
        this.fromAgentId = fromAgentId;
        this.toAgentId = toAgentId;
        this.conversationId = conversationId;
        this.replyToMessageId = replyToMessageId;
        this.type = type;
        this.audienceType = audienceType == null ? AgentMessageAudienceType.DIRECT : audienceType;
        this.audienceSpecJson = audienceSpecJson == null ? "{}" : audienceSpecJson;
        this.subject = subject;
        this.content = content;
        this.hopCount = hopCount;
        this.status = AgentMessageStatus.CREATED;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public UUID getFromAgentId() { return fromAgentId; }
    public UUID getToAgentId() { return toAgentId; }
    public UUID getConversationId() { return conversationId; }
    public UUID getReplyToMessageId() { return replyToMessageId; }
    public AgentMessageType getType() { return type; }
    public AgentMessageAudienceType getAudienceType() { return audienceType; }
    public String getAudienceSpecJson() { return audienceSpecJson; }
    public String getSubject() { return subject; }
    public String getContent() { return content; }
    public int getHopCount() { return hopCount; }
    public AgentMessageStatus getStatus() { return status; }
    public String getQueuedSubmissionId() { return queuedSubmissionId; }
    public String getTurnId() { return turnId; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void markQueued(String queuedSubmissionId) {
        this.status = AgentMessageStatus.QUEUED;
        this.queuedSubmissionId = queuedSubmissionId;
        this.turnId = null;
        this.lastError = null;
    }

    public void markDispatched(String queuedSubmissionId, String turnId) {
        this.status = turnId == null || turnId.isBlank() ? AgentMessageStatus.DISPATCHED : AgentMessageStatus.PROCESSING;
        this.queuedSubmissionId = queuedSubmissionId;
        this.turnId = turnId;
        this.lastError = null;
    }

    public void markProcessing(String turnId) {
        this.status = AgentMessageStatus.PROCESSING;
        if (turnId != null && !turnId.isBlank()) this.turnId = turnId;
        this.lastError = null;
    }

    public void markCompleted() {
        this.status = AgentMessageStatus.COMPLETED;
        this.lastError = null;
    }

    public void markPartial(String error) {
        this.status = AgentMessageStatus.PARTIAL;
        this.lastError = error;
    }

    public void markFailed(String error) {
        this.status = AgentMessageStatus.FAILED;
        this.lastError = error;
    }

    public void markCreated() {
        this.status = AgentMessageStatus.CREATED;
        this.lastError = null;
    }
}
