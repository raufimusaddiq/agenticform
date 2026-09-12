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
@Table(name = "remote_codex_interactions")
public class RemoteCodexInteractionEntity {
    public enum Status { PENDING, READY, CONSUMED, FAILED }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "node_id", nullable = false)
    private UUID nodeId;

    @Column(name = "agent_id", nullable = false)
    private UUID agentId;

    @Column(name = "runtime_generation", nullable = false)
    private long runtimeGeneration;

    @Column(name = "codex_request_id", nullable = false)
    private String codexRequestId;

    @Column(nullable = false)
    private String method;

    @Column(name = "params_json", nullable = false, columnDefinition = "text")
    private String paramsJson;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status = Status.PENDING;

    @Column(name = "response_json", columnDefinition = "text")
    private String responseJson;

    @Column(name = "last_error", columnDefinition = "text")
    private String lastError;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "resolved_at")
    private Instant resolvedAt;

    @Column(name = "consumed_at")
    private Instant consumedAt;

    protected RemoteCodexInteractionEntity() {}

    public RemoteCodexInteractionEntity(UUID nodeId, UUID agentId, long runtimeGeneration,
                                        String codexRequestId, String method, String paramsJson) {
        this.nodeId = nodeId;
        this.agentId = agentId;
        this.runtimeGeneration = runtimeGeneration;
        this.codexRequestId = codexRequestId;
        this.method = method;
        this.paramsJson = paramsJson;
    }

    @PrePersist
    void onCreate() { createdAt = Instant.now(); }

    public void ready(String responseJson) {
        if (status == Status.CONSUMED) return;
        status = Status.READY;
        this.responseJson = responseJson;
        this.lastError = null;
        this.resolvedAt = Instant.now();
    }

    public void fail(String error) {
        if (status == Status.CONSUMED) return;
        status = Status.FAILED;
        this.lastError = error;
        this.resolvedAt = Instant.now();
    }

    public void consumed() {
        if (status != Status.READY) throw new IllegalStateException("Remote Codex interaction is not ready");
        status = Status.CONSUMED;
        consumedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getNodeId() { return nodeId; }
    public UUID getAgentId() { return agentId; }
    public long getRuntimeGeneration() { return runtimeGeneration; }
    public String getCodexRequestId() { return codexRequestId; }
    public String getMethod() { return method; }
    public String getParamsJson() { return paramsJson; }
    public Status getStatus() { return status; }
    public String getResponseJson() { return responseJson; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getResolvedAt() { return resolvedAt; }
    public Instant getConsumedAt() { return consumedAt; }
}
