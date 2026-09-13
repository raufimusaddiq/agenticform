package com.agenticform.agent;

import com.agenticform.workspace.WorkspaceMode;
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
import java.util.Objects;
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

    @Column(length = 64)
    private String specialty;

    @Enumerated(EnumType.STRING)
    @Column(name = "runtime_type", nullable = false, length = 32)
    private RuntimeType runtimeType;

    @Column(name = "runtime_session_id")
    private String runtimeSessionId;

    @Column(name = "runtime_profile_id", length = 128)
    private String runtimeProfileId;

    @Enumerated(EnumType.STRING)
    @Column(name = "workspace_mode", nullable = false)
    private WorkspaceMode workspaceMode;

    @Column(name = "source_directory")
    private String sourceDirectory;

    @Column(name = "working_directory")
    private String workingDirectory;

    private String branch;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private AgentStatus status;

    @Enumerated(EnumType.STRING)
    @Column(name = "queue_mode", nullable = false)
    private AgentQueueMode queueMode;

    @Enumerated(EnumType.STRING)
    @Column(name = "human_control_mode", nullable = false)
    private HumanControlMode humanControlMode;

    @Enumerated(EnumType.STRING)
    @Column(name = "agent_role", nullable = false, length = 32)
    private AgentRole role = AgentRole.GENERAL;

    @Enumerated(EnumType.STRING)
    @Column(name = "capability_profile", nullable = false, length = 32)
    private AgentCapabilityProfile capabilityProfile = AgentCapabilityProfile.IMPLEMENTER;

    @Column(name = "system_managed", nullable = false)
    private boolean systemManaged;

    @Column(name = "execution_node_id")
    private UUID executionNodeId;

    @Column(name = "runtime_generation", nullable = false)
    private long runtimeGeneration;

    @Column(name = "active_task_id")
    private UUID activeTaskId;

    @Column(name = "active_turn_id")
    private String activeTurnId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected AgentEntity() {}

    public AgentEntity(UUID projectId, String name, String responsibility, String runtimeSessionId,
                       WorkspaceMode workspaceMode, String sourceDirectory, String workingDirectory,
                       String branch, AgentQueueMode queueMode, HumanControlMode humanControlMode) {
        this(projectId, name, responsibility, runtimeSessionId, workspaceMode, sourceDirectory, workingDirectory,
                branch, queueMode, humanControlMode, AgentRole.GENERAL, false, null, AgentCapabilityProfile.IMPLEMENTER);
    }

    public AgentEntity(UUID projectId, String name, String responsibility, String runtimeSessionId,
                       WorkspaceMode workspaceMode, String sourceDirectory, String workingDirectory,
                       String branch, AgentQueueMode queueMode, HumanControlMode humanControlMode,
                       AgentRole role, boolean systemManaged) {
        this(projectId, name, responsibility, runtimeSessionId, workspaceMode, sourceDirectory, workingDirectory,
                branch, queueMode, humanControlMode, role, systemManaged, null,
                systemProfile(role, systemManaged));
    }

    public AgentEntity(UUID projectId, String name, String responsibility, String runtimeSessionId,
                       WorkspaceMode workspaceMode, String sourceDirectory, String workingDirectory,
                       String branch, AgentQueueMode queueMode, HumanControlMode humanControlMode,
                       AgentRole role, boolean systemManaged, UUID executionNodeId) {
        this(projectId, name, responsibility, runtimeSessionId, workspaceMode, sourceDirectory, workingDirectory,
                branch, queueMode, humanControlMode, role, systemManaged, executionNodeId,
                systemProfile(role, systemManaged));
    }

    public AgentEntity(UUID projectId, String name, String responsibility, String runtimeSessionId,
                       WorkspaceMode workspaceMode, String sourceDirectory, String workingDirectory,
                       String branch, AgentQueueMode queueMode, HumanControlMode humanControlMode,
                       AgentRole role, boolean systemManaged, UUID executionNodeId,
                       AgentCapabilityProfile capabilityProfile) {
        this.projectId = projectId;
        this.name = name;
        this.responsibility = responsibility;
        this.runtimeSessionId = runtimeSessionId;
        this.workspaceMode = workspaceMode;
        this.sourceDirectory = sourceDirectory;
        this.workingDirectory = workingDirectory;
        this.branch = branch;
        this.queueMode = queueMode;
        this.humanControlMode = humanControlMode;
        this.role = role == null ? AgentRole.GENERAL : role;
        this.systemManaged = systemManaged;
        this.capabilityProfile = this.role == AgentRole.OPERATIONAL || systemManaged
                ? systemProfile(this.role, true)
                : (capabilityProfile == null ? AgentCapabilityProfile.IMPLEMENTER : capabilityProfile);
        this.executionNodeId = executionNodeId;
        this.runtimeGeneration = executionNodeId == null ? 0 : 1;
        this.status = runtimeSessionId == null ? AgentStatus.STARTING : AgentStatus.IDLE;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public String getName() { return name; }
    public String getResponsibility() { return responsibility; }
    public String getSpecialty() { return specialty; }
    public RuntimeType getRuntimeType() { return runtimeType; }
    public String getRuntimeSessionId() { return runtimeSessionId; }
    public String getRuntimeProfileId() { return runtimeProfileId; }
    public WorkspaceMode getWorkspaceMode() { return workspaceMode; }
    public String getSourceDirectory() { return sourceDirectory; }
    public String getWorkingDirectory() { return workingDirectory; }
    public String getBranch() { return branch; }
    public AgentStatus getStatus() { return status; }
    public AgentQueueMode getQueueMode() { return queueMode; }
    public HumanControlMode getHumanControlMode() { return humanControlMode; }
    public AgentRole getRole() { return role; }
    public AgentCapabilityProfile getCapabilityProfile() { return capabilityProfile; }
    public boolean isSystemManaged() { return systemManaged; }
    public UUID getExecutionNodeId() { return executionNodeId; }
    public long getRuntimeGeneration() { return runtimeGeneration; }
    public UUID getActiveTaskId() { return activeTaskId; }
    public String getActiveTurnId() { return activeTurnId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void setStatus(AgentStatus status) { this.status = status; }
    public void setQueueMode(AgentQueueMode queueMode) { this.queueMode = queueMode; }
    public void setHumanControlMode(HumanControlMode humanControlMode) { this.humanControlMode = humanControlMode; }
    public void setExecutionNodeId(UUID executionNodeId) { this.executionNodeId = executionNodeId; }
    public void setRuntimeType(RuntimeType runtimeType) {
        this.runtimeType = Objects.requireNonNull(runtimeType, "Runtime type is required");
    }
    public void setRuntimeProfileId(String runtimeProfileId) {
        this.runtimeProfileId = runtimeProfileId == null || runtimeProfileId.isBlank() ? null : runtimeProfileId.trim();
    }
    public void setActiveTaskId(UUID activeTaskId) { this.activeTaskId = activeTaskId; }
    public void setActiveTurnId(String activeTurnId) { this.activeTurnId = activeTurnId; }
    public void setSpecialty(String specialty) { this.specialty = specialty == null || specialty.isBlank() ? null : specialty.trim().toUpperCase(); }

    public void setCapabilityProfile(AgentCapabilityProfile capabilityProfile) {
        if (role == AgentRole.OPERATIONAL || systemManaged) {
            AgentCapabilityProfile required = systemProfile(role, true);
            if (capabilityProfile != required) {
                throw new IllegalArgumentException("System-managed agent capability profile is fixed to " + required);
            }
            this.capabilityProfile = required;
            return;
        }
        this.capabilityProfile = capabilityProfile == null ? AgentCapabilityProfile.IMPLEMENTER : capabilityProfile;
    }

    public boolean ownsRuntime(UUID nodeId, long generation, RuntimeType runtimeType, String runtimeSessionId) {
        return executionNodeId != null && executionNodeId.equals(nodeId)
                && runtimeGeneration == generation
                && this.runtimeType == runtimeType
                && Objects.equals(this.runtimeSessionId, runtimeSessionId);
    }

    public boolean ownsRuntimeAssignment(UUID nodeId, long generation, RuntimeType runtimeType) {
        return executionNodeId != null && executionNodeId.equals(nodeId)
                && runtimeGeneration == generation
                && this.runtimeType == runtimeType;
    }

    public long reassignRuntime(UUID nodeId, String requestedBranch) {
        if (nodeId == null) throw new IllegalArgumentException("Execution node is required");
        executionNodeId = nodeId;
        runtimeGeneration++;
        runtimeSessionId = null;
        sourceDirectory = null;
        workingDirectory = null;
        branch = requestedBranch;
        activeTurnId = null;
        status = AgentStatus.STARTING;
        return runtimeGeneration;
    }

    public void bindRuntime(long generation, RuntimeType runtimeType, String runtimeSessionId,
                            String sourceDirectory, String workingDirectory, String branch) {
        if (runtimeGeneration != generation) {
            throw new IllegalStateException("Stale agent runtime generation: " + generation + ", expected " + runtimeGeneration);
        }
        this.runtimeType = Objects.requireNonNull(runtimeType, "Runtime type is required");
        this.runtimeSessionId = runtimeSessionId;
        this.sourceDirectory = sourceDirectory;
        this.workingDirectory = workingDirectory;
        this.branch = branch;
        this.status = AgentStatus.IDLE;
    }

    public void recoverFromSnapshot(long generation, String runtimeSessionId, String sourceDirectory,
                                    String workingDirectory, String branch) {
        if (runtimeGeneration != generation) return;
        if (this.runtimeSessionId == null || this.runtimeSessionId.isBlank()) this.runtimeSessionId = runtimeSessionId;
        if (sourceDirectory != null && !sourceDirectory.isBlank()) this.sourceDirectory = sourceDirectory;
        if (workingDirectory != null && !workingDirectory.isBlank()) this.workingDirectory = workingDirectory;
        if (branch != null && !branch.isBlank()) this.branch = branch;
        if (status == AgentStatus.DISCONNECTED || status == AgentStatus.STARTING) {
            status = activeTurnId == null ? AgentStatus.IDLE : AgentStatus.WORKING;
        }
    }

    private static AgentCapabilityProfile systemProfile(AgentRole role, boolean systemManaged) {
        if (role == AgentRole.OPERATIONAL) return AgentCapabilityProfile.OPS;
        if (systemManaged && role == AgentRole.ORCHESTRATOR) return AgentCapabilityProfile.ORCHESTRATOR;
        return systemManaged ? AgentCapabilityProfile.OPS : AgentCapabilityProfile.IMPLEMENTER;
    }
}
