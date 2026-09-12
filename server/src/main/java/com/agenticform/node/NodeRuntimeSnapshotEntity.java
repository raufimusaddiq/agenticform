package com.agenticform.node;

import com.agenticform.runtime.RuntimeType;
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
@Table(name = "node_runtime_snapshots")
public class NodeRuntimeSnapshotEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "node_id", nullable = false)
    private UUID nodeId;

    @Column(name = "agent_id", nullable = false)
    private UUID agentId;

    @Column(name = "runtime_generation", nullable = false)
    private long runtimeGeneration;

    @Enumerated(EnumType.STRING)
    @Column(name = "runtime_type", nullable = false, length = 32)
    private RuntimeType runtimeType = RuntimeType.CODEX;

    @Column(name = "runtime_session_id")
    private String runtimeSessionId;

    @Column(name = "source_directory", columnDefinition = "text")
    private String sourceDirectory;

    @Column(name = "working_directory", columnDefinition = "text")
    private String workingDirectory;

    private String branch;

    @Column(name = "runtime_status", nullable = false, length = 32)
    private String runtimeStatus;

    @Column(name = "observed_at", nullable = false)
    private Instant observedAt;

    protected NodeRuntimeSnapshotEntity() {}

    public NodeRuntimeSnapshotEntity(UUID nodeId, UUID agentId) {
        this.nodeId = nodeId;
        this.agentId = agentId;
    }

    @PrePersist
    @PreUpdate
    void timestamps() {
        if (observedAt == null) observedAt = Instant.now();
    }

    public void observe(RuntimeType runtimeType, long runtimeGeneration, String runtimeSessionId, String sourceDirectory,
                        String workingDirectory, String branch, String runtimeStatus) {
        this.runtimeType = java.util.Objects.requireNonNull(runtimeType, "Runtime type is required");
        this.runtimeGeneration = runtimeGeneration;
        this.runtimeSessionId = runtimeSessionId;
        this.sourceDirectory = sourceDirectory;
        this.workingDirectory = workingDirectory;
        this.branch = branch;
        this.runtimeStatus = runtimeStatus == null || runtimeStatus.isBlank() ? "UNKNOWN" : runtimeStatus;
        this.observedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getNodeId() { return nodeId; }
    public UUID getAgentId() { return agentId; }
    public long getRuntimeGeneration() { return runtimeGeneration; }
    public RuntimeType getRuntimeType() { return runtimeType; }
    public String getRuntimeSessionId() { return runtimeSessionId; }
    public String getSourceDirectory() { return sourceDirectory; }
    public String getWorkingDirectory() { return workingDirectory; }
    public String getBranch() { return branch; }
    public String getRuntimeStatus() { return runtimeStatus; }
    public Instant getObservedAt() { return observedAt; }
}
