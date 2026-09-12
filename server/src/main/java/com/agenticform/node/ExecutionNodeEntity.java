package com.agenticform.node;

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
@Table(name = "execution_nodes")
public class ExecutionNodeEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false, unique = true, length = 128)
    private String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private ExecutionNodeStatus status;

    @Enumerated(EnumType.STRING)
    @Column(name = "trust_level", nullable = false, length = 32)
    private NodeTrustLevel trustLevel;

    @Column(name = "public_key_base64", nullable = false, columnDefinition = "text")
    private String publicKeyBase64;

    @Column(nullable = false, unique = true, length = 128)
    private String fingerprint;

    @Column(name = "drain_requested", nullable = false)
    private boolean drainRequested;

    @Column(name = "protocol_version", nullable = false)
    private int protocolVersion = ExecutionNodeProtocol.CURRENT;

    @Column(name = "labels_json", nullable = false, columnDefinition = "text")
    private String labelsJson = "{}";

    @Column(name = "capabilities_json", nullable = false, columnDefinition = "text")
    private String capabilitiesJson = "{}";

    @Column(name = "max_agents", nullable = false)
    private int maxAgents = 1;

    private String os;
    private String arch;
    private String hostname;

    @Column(name = "node_version")
    private String nodeVersion;

    @Column(name = "cpu_cores")
    private Integer cpuCores;

    @Column(name = "memory_mb")
    private Long memoryMb;

    @Column(name = "disk_free_mb")
    private Long diskFreeMb;

    @Column(name = "enrolled_at", nullable = false)
    private Instant enrolledAt;

    @Column(name = "last_seen_at")
    private Instant lastSeenAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected ExecutionNodeEntity() {}

    public ExecutionNodeEntity(String name, NodeTrustLevel trustLevel, String publicKeyBase64, String fingerprint) {
        this.name = name;
        this.trustLevel = trustLevel;
        this.publicKeyBase64 = publicKeyBase64;
        this.fingerprint = fingerprint;
        this.status = ExecutionNodeStatus.ONLINE;
        this.protocolVersion = ExecutionNodeProtocol.CURRENT;
        this.enrolledAt = Instant.now();
        this.lastSeenAt = this.enrolledAt;
    }

    @PrePersist
    void onCreate() {
        createdAt = updatedAt = Instant.now();
    }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public void heartbeat(int protocolVersion, String labelsJson, String capabilitiesJson, int maxAgents,
                          String os, String arch, String hostname, String nodeVersion,
                          Integer cpuCores, Long memoryMb, Long diskFreeMb) {
        if (status == ExecutionNodeStatus.REVOKED || status == ExecutionNodeStatus.DISABLED) return;
        if (status == ExecutionNodeStatus.OFFLINE) {
            status = drainRequested ? ExecutionNodeStatus.DRAINING : ExecutionNodeStatus.ONLINE;
        }
        this.protocolVersion = protocolVersion;
        this.labelsJson = labelsJson == null || labelsJson.isBlank() ? "{}" : labelsJson;
        this.capabilitiesJson = capabilitiesJson == null || capabilitiesJson.isBlank() ? "{}" : capabilitiesJson;
        this.maxAgents = Math.max(1, maxAgents);
        this.os = os;
        this.arch = arch;
        this.hostname = hostname;
        this.nodeVersion = nodeVersion;
        this.cpuCores = cpuCores;
        this.memoryMb = memoryMb;
        this.diskFreeMb = diskFreeMb;
        this.lastSeenAt = Instant.now();
    }

    public void setStatus(ExecutionNodeStatus status) {
        if (this.status == ExecutionNodeStatus.REVOKED && status != ExecutionNodeStatus.REVOKED) {
            throw new IllegalStateException("Revoked execution node must be enrolled again");
        }
        this.status = status;
        if (status == ExecutionNodeStatus.DRAINING) drainRequested = true;
        if (status == ExecutionNodeStatus.ONLINE || status == ExecutionNodeStatus.DISABLED
                || status == ExecutionNodeStatus.REVOKED) {
            drainRequested = false;
        }
        if (status == ExecutionNodeStatus.REVOKED) revokedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public ExecutionNodeStatus getStatus() { return status; }
    public NodeTrustLevel getTrustLevel() { return trustLevel; }
    public String getPublicKeyBase64() { return publicKeyBase64; }
    public String getFingerprint() { return fingerprint; }
    public boolean isDrainRequested() { return drainRequested; }
    public int getProtocolVersion() { return protocolVersion; }
    public boolean isProtocolCompatible() { return ExecutionNodeProtocol.compatible(protocolVersion); }
    public String getLabelsJson() { return labelsJson; }
    public String getCapabilitiesJson() { return capabilitiesJson; }
    public int getMaxAgents() { return maxAgents; }
    public String getOs() { return os; }
    public String getArch() { return arch; }
    public String getHostname() { return hostname; }
    public String getNodeVersion() { return nodeVersion; }
    public Integer getCpuCores() { return cpuCores; }
    public Long getMemoryMb() { return memoryMb; }
    public Long getDiskFreeMb() { return diskFreeMb; }
    public Instant getEnrolledAt() { return enrolledAt; }
    public Instant getLastSeenAt() { return lastSeenAt; }
    public Instant getRevokedAt() { return revokedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
