package com.agenticform.node;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "node_commands")
public class NodeCommandEntity {
    public enum Status { QUEUED, LEASED, SUCCEEDED, FAILED }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "node_id", nullable = false)
    private UUID nodeId;

    @Column(name = "agent_id")
    private UUID agentId;

    @Column(name = "command_type", nullable = false, length = 64)
    private String commandType;

    @Column(name = "idempotency_key", nullable = false, unique = true)
    private String idempotencyKey;

    @Column(name = "payload_json", nullable = false, columnDefinition = "text")
    private String payloadJson;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status = Status.QUEUED;

    @Column(name = "lease_until")
    private Instant leaseUntil;

    @Column(name = "result_json", columnDefinition = "text")
    private String resultJson;

    @Column(name = "last_error", columnDefinition = "text")
    private String lastError;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "leased_at")
    private Instant leasedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    protected NodeCommandEntity() {}

    public NodeCommandEntity(UUID nodeId, UUID agentId, String commandType,
                             String idempotencyKey, String payloadJson) {
        this.nodeId = nodeId;
        this.agentId = agentId;
        this.commandType = commandType;
        this.idempotencyKey = idempotencyKey;
        this.payloadJson = payloadJson;
    }

    @PrePersist
    void onCreate() { createdAt = Instant.now(); }

    public boolean available(Instant now) {
        return status == Status.QUEUED || (status == Status.LEASED && leaseUntil != null && leaseUntil.isBefore(now));
    }

    public void lease(Instant until) {
        status = Status.LEASED;
        leasedAt = Instant.now();
        leaseUntil = until;
    }

    public void succeed(String resultJson) {
        status = Status.SUCCEEDED;
        this.resultJson = resultJson;
        this.lastError = null;
        this.completedAt = Instant.now();
        this.leaseUntil = null;
    }

    public void fail(String error) {
        status = Status.FAILED;
        this.lastError = error;
        this.completedAt = Instant.now();
        this.leaseUntil = null;
    }

    public UUID getId() { return id; }
    public UUID getNodeId() { return nodeId; }
    public UUID getAgentId() { return agentId; }
    public String getCommandType() { return commandType; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getPayloadJson() { return payloadJson; }
    public Status getStatus() { return status; }
    public Instant getLeaseUntil() { return leaseUntil; }
    public String getResultJson() { return resultJson; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getLeasedAt() { return leasedAt; }
    public Instant getCompletedAt() { return completedAt; }
}
