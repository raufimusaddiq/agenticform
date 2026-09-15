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

    @Column(name = "parent_task_id")
    private UUID parentTaskId;

    @Column(name = "workflow_id", nullable = false)
    private UUID workflowId;

    @Column(nullable = false)
    private String title;

    @Column(nullable = false, columnDefinition = "text")
    private String prompt;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private TaskStatus status;

    @Column(nullable = false)
    private int priority;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private TaskKind kind;

    @Column(name = "queued_submission_id")
    private String queuedSubmissionId;

    @Column(name = "turn_id")
    private String turnId;

    @Column(name = "last_error", columnDefinition = "text")
    private String lastError;

    @Column(columnDefinition = "text")
    private String report;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private TaskDeliverable deliverable = TaskDeliverable.GENERAL;

    @Enumerated(EnumType.STRING)
    @Column(name = "delivery_stage", nullable = false, length = 32)
    private TaskDeliveryStage deliveryStage = TaskDeliveryStage.NOT_STARTED;

    @Column(name = "review_required", nullable = false)
    private boolean reviewRequired;

    @Column(name = "architecture_required", nullable = false)
    private boolean architectureRequired;

    @Column(name = "deployment_required", nullable = false)
    private boolean deploymentRequired;

    @Column(name = "environment_key", length = 64)
    private String environmentKey;

    @Column(name = "evidence_json", columnDefinition = "text")
    private String evidenceJson;

    @Column(name = "delivery_environment", length = 64)
    private String deliveryEnvironment;

    @Column(name = "delivery_revision", length = 256)
    private String deliveryRevision;

    @Column(name = "delivery_artifact_digest", length = 256)
    private String deliveryArtifactDigest;

    @Column(name = "delivery_operation_run_id")
    private UUID deliveryOperationRunId;

    @Column(name = "delivery_verified_at")
    private Instant deliveryVerifiedAt;

    @Column(name = "delivery_health_evidence", columnDefinition = "text")
    private String deliveryHealthEvidence;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected TaskEntity() {}

    public TaskEntity(UUID projectId, UUID assignedAgentId, String title, String prompt, int priority) {
        this(projectId, assignedAgentId, title, prompt, priority, null);
    }

    public TaskEntity(UUID projectId, UUID assignedAgentId, String title, String prompt, int priority, UUID parentTaskId) {
        this(projectId, assignedAgentId, title, prompt, priority, parentTaskId, TaskKind.GENERAL);
    }

    public TaskEntity(UUID projectId, UUID assignedAgentId, String title, String prompt, int priority,
                      UUID parentTaskId, TaskKind kind) {
        this(projectId, assignedAgentId, title, prompt, priority, parentTaskId, kind, UUID.randomUUID());
    }

    public TaskEntity(UUID projectId, UUID assignedAgentId, String title, String prompt, int priority,
                      UUID parentTaskId, TaskKind kind, UUID workflowId) {
        this.projectId = projectId;
        this.assignedAgentId = assignedAgentId;
        this.parentTaskId = parentTaskId;
        this.workflowId = workflowId == null ? UUID.randomUUID() : workflowId;
        this.title = title;
        this.prompt = prompt;
        this.priority = priority;
        this.kind = kind == null ? TaskKind.GENERAL : kind;
        this.status = TaskStatus.READY;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public UUID getAssignedAgentId() { return assignedAgentId; }
    public UUID getParentTaskId() { return parentTaskId; }
    public UUID getWorkflowId() { return workflowId; }
    public String getTitle() { return title; }
    public String getPrompt() { return prompt; }
    public TaskStatus getStatus() { return status; }
    public int getPriority() { return priority; }
    public TaskKind getKind() { return kind; }
    public String getQueuedSubmissionId() { return queuedSubmissionId; }
    public String getTurnId() { return turnId; }
    public String getLastError() { return lastError; }
    public String getReport() { return report; }
    public TaskDeliverable getDeliverable() { return deliverable; }
    public TaskDeliveryStage getDeliveryStage() { return deliveryStage; }
    public boolean isReviewRequired() { return reviewRequired; }
    public boolean isArchitectureRequired() { return architectureRequired; }
    public boolean isDeploymentRequired() { return deploymentRequired; }
    public String getEnvironmentKey() { return environmentKey; }
    public String getEvidenceJson() { return evidenceJson; }
    public String getDeliveryEnvironment() { return deliveryEnvironment; }
    public String getDeliveryRevision() { return deliveryRevision; }
    public String getDeliveryArtifactDigest() { return deliveryArtifactDigest; }
    public UUID getDeliveryOperationRunId() { return deliveryOperationRunId; }
    public Instant getDeliveryVerifiedAt() { return deliveryVerifiedAt; }
    public String getDeliveryHealthEvidence() { return deliveryHealthEvidence; }

    public TaskEvidence getEvidence() { return TaskEvidence.parse(evidenceJson); }

    public boolean hasVerifiedDelivery() {
        return deliveryStage == TaskDeliveryStage.DELIVERED
                && deliveryVerifiedAt != null
                && deliveryEnvironment != null && !deliveryEnvironment.isBlank()
                && deliveryRevision != null && !deliveryRevision.isBlank();
    }

    /**
     * True when this task's requested deliverable requires a verified target
     * environment. Explicitly narrower requests keep their own terminal gate.
     */
    public boolean requiresVerifiedDelivery() {
        return deploymentRequired && parentTaskId == null && deliveryStage != TaskDeliveryStage.DELIVERED;
    }

    public void configureDelivery(TaskDeliverable deliverable, boolean reviewRequired,
                                  boolean architectureRequired, boolean deploymentRequired,
                                  String environmentKey) {
        if (deliverable != null) this.deliverable = deliverable;
        this.reviewRequired = reviewRequired;
        this.architectureRequired = architectureRequired;
        this.deploymentRequired = deploymentRequired;
        this.environmentKey = environmentKey;
    }

    public void recordEvidence(TaskEvidence evidence) {
        this.evidenceJson = evidence.serialize();
        if (evidence.outcome() != null && evidence.outcome().equals(TaskEvidence.COMPLETED)
                && deliveryStage == TaskDeliveryStage.NOT_STARTED) {
            this.deliveryStage = TaskDeliveryStage.IMPLEMENTED;
        }
    }

    public void setDeliveryStage(TaskDeliveryStage stage) { this.deliveryStage = stage; }

    public void recordVerifiedDelivery(String environment, String revision, String artifactDigest,
                                       UUID operationRunId, String healthEvidence) {
        this.deliveryEnvironment = environment;
        this.deliveryRevision = revision;
        this.deliveryArtifactDigest = artifactDigest;
        this.deliveryOperationRunId = operationRunId;
        this.deliveryHealthEvidence = healthEvidence;
        this.deliveryVerifiedAt = Instant.now();
        this.deliveryStage = TaskDeliveryStage.DELIVERED;
    }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public String getDependencyReason() {
        return status == TaskStatus.WAITING_DEPENDENCY ? lastError : null;
    }

    public String getBlocker() {
        if (status == TaskStatus.BLOCKED) return lastError;
        return report != null && report.startsWith("BLOCKER:") ? report : null;
    }

    public String getNextAction() {
        return switch (status) {
            case READY -> "Queued for automatic dispatch when the assigned agent is idle";
            case DISPATCHING, DISPATCHED -> "Wait for runtime acceptance/start";
            case RUNNING -> "Wait for task report or blocker";
            case WAITING_DEPENDENCY -> "Resolve prerequisite or delegated task";
            case WAITING_APPROVAL -> "Resolve the pending approval";
            case BLOCKED -> "Review blocker, then redispatch or change scope";
            case COMPLETED -> "No action";
            case FAILED -> "Inspect failure, then retry only after reconciliation";
            case CANCELLED, PAUSED, QUEUED -> "Resume or cancel deliberately";
        };
    }

    public void setStatus(TaskStatus status) { this.status = status; }
    public void setQueuedSubmissionId(String value) { this.queuedSubmissionId = value; }
    public void setTurnId(String value) { this.turnId = value; }
    public void setLastError(String value) { this.lastError = value; }
    public void setReport(String value) { this.report = value; }
}
