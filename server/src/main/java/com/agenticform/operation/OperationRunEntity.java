package com.agenticform.operation;

import com.agenticform.policy.PolicyEffect;
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
@Table(name = "operation_runs")
public class OperationRunEntity {
    public enum Status {
        WAITING_APPROVAL,
        QUEUED,
        RUNNING,
        SUCCEEDED,
        FAILED,
        DENIED,
        DECLINED,
        INTERRUPTED
    }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "runbook_id", nullable = false)
    private UUID runbookId;

    @Column(name = "environment_id", nullable = false)
    private UUID environmentId;

    @Column(name = "requested_agent_id")
    private UUID requestedAgentId;

    @Column(name = "requested_task_id")
    private UUID requestedTaskId;

    @Column(name = "requested_by", nullable = false, length = 128)
    private String requestedBy;

    @Column(nullable = false, length = 128)
    private String action;

    @Column(name = "environment_key", nullable = false, length = 64)
    private String environmentKey;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status;

    @Enumerated(EnumType.STRING)
    @Column(name = "policy_effect", nullable = false, length = 32)
    private PolicyEffect policyEffect;

    @Column(name = "policy_rule_id")
    private UUID policyRuleId;

    @Column(name = "runbook_snapshot", nullable = false, columnDefinition = "text")
    private String runbookSnapshot;

    @Column(name = "parameters_json", nullable = false, columnDefinition = "text")
    private String parametersJson;

    @Column(name = "approved_by", length = 128)
    private String approvedBy;

    @Column(name = "last_error", columnDefinition = "text")
    private String lastError;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "approved_at")
    private Instant approvedAt;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    protected OperationRunEntity() {}

    public OperationRunEntity(UUID projectId, UUID runbookId, UUID environmentId,
                              UUID requestedAgentId, UUID requestedTaskId, String requestedBy,
                              String action, String environmentKey, Status status,
                              PolicyEffect policyEffect, UUID policyRuleId,
                              String runbookSnapshot, String parametersJson) {
        this.projectId = projectId;
        this.runbookId = runbookId;
        this.environmentId = environmentId;
        this.requestedAgentId = requestedAgentId;
        this.requestedTaskId = requestedTaskId;
        this.requestedBy = requestedBy;
        this.action = action;
        this.environmentKey = environmentKey;
        this.status = status;
        this.policyEffect = policyEffect;
        this.policyRuleId = policyRuleId;
        this.runbookSnapshot = runbookSnapshot;
        this.parametersJson = parametersJson;
    }

    @PrePersist
    void onCreate() { createdAt = Instant.now(); }

    public void updatePolicy(PolicyEffect effect, UUID ruleId) {
        this.policyEffect = effect;
        this.policyRuleId = ruleId;
    }

    public void approve(String approvedBy) {
        this.approvedBy = approvedBy;
        this.approvedAt = Instant.now();
        this.status = Status.QUEUED;
        this.lastError = null;
    }

    public void queue() {
        this.status = Status.QUEUED;
        this.lastError = null;
    }

    public void start() {
        this.status = Status.RUNNING;
        this.startedAt = Instant.now();
        this.lastError = null;
    }

    public void succeed() {
        this.status = Status.SUCCEEDED;
        this.completedAt = Instant.now();
        this.lastError = null;
    }

    public void fail(String error) {
        this.status = Status.FAILED;
        this.lastError = error;
        this.completedAt = Instant.now();
    }

    public void deny(String reason) {
        this.status = Status.DENIED;
        this.lastError = reason;
        this.completedAt = Instant.now();
    }

    public void decline(String reason, String actor) {
        this.status = Status.DECLINED;
        this.lastError = reason;
        this.approvedBy = actor;
        this.completedAt = Instant.now();
    }

    public void interrupt(String reason) {
        this.status = Status.INTERRUPTED;
        this.lastError = reason;
        this.completedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public UUID getRunbookId() { return runbookId; }
    public UUID getEnvironmentId() { return environmentId; }
    public UUID getRequestedAgentId() { return requestedAgentId; }
    public UUID getRequestedTaskId() { return requestedTaskId; }
    public String getRequestedBy() { return requestedBy; }
    public String getAction() { return action; }
    public String getEnvironmentKey() { return environmentKey; }
    public Status getStatus() { return status; }
    public PolicyEffect getPolicyEffect() { return policyEffect; }
    public UUID getPolicyRuleId() { return policyRuleId; }
    public String getRunbookSnapshot() { return runbookSnapshot; }
    public String getParametersJson() { return parametersJson; }
    public String getApprovedBy() { return approvedBy; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getApprovedAt() { return approvedAt; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getCompletedAt() { return completedAt; }
}
