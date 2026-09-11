package com.agenticform.operation;

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
@Table(name = "operation_external_waits")
public class OperationExternalWaitEntity {
    public enum Status { WAITING, SUCCEEDED, FAILED, TIMED_OUT }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "operation_run_id", nullable = false)
    private UUID operationRunId;

    @Column(name = "step_run_id", nullable = false, unique = true)
    private UUID stepRunId;

    @Column(nullable = false, length = 32)
    private String provider;

    @Column(nullable = false, length = 16)
    private String mode;

    @Column(nullable = false, length = 255)
    private String repository;

    @Column(nullable = false, length = 255)
    private String workflow;

    @Column(nullable = false, length = 255)
    private String ref;

    @Column(name = "expected_head_sha", nullable = false, length = 64)
    private String expectedHeadSha;

    @Column(name = "external_run_id")
    private Long externalRunId;

    @Column(name = "external_url", columnDefinition = "text")
    private String externalUrl;

    @Column(name = "correlation_not_before")
    private Instant correlationNotBefore;

    @Column(nullable = false)
    private Instant deadline;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status;

    @Column(name = "last_observed_status", length = 32)
    private String lastObservedStatus;

    @Column(name = "last_observed_conclusion", length = 32)
    private String lastObservedConclusion;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected OperationExternalWaitEntity() {}

    public OperationExternalWaitEntity(UUID operationRunId, UUID stepRunId, String mode,
                                       String repository, String workflow, String ref,
                                       String expectedHeadSha, Instant correlationNotBefore,
                                       Instant deadline) {
        this.operationRunId = operationRunId;
        this.stepRunId = stepRunId;
        this.provider = "github-actions";
        this.mode = mode;
        this.repository = repository;
        this.workflow = workflow;
        this.ref = ref;
        this.expectedHeadSha = expectedHeadSha;
        this.correlationNotBefore = correlationNotBefore;
        this.deadline = deadline;
        this.status = Status.WAITING;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public void observe(long runId, String url, String workflowStatus, String conclusion) {
        this.externalRunId = runId;
        this.externalUrl = url;
        this.lastObservedStatus = workflowStatus;
        this.lastObservedConclusion = conclusion;
    }

    public void succeed() { this.status = Status.SUCCEEDED; }
    public void fail() { this.status = Status.FAILED; }
    public void timeout() { this.status = Status.TIMED_OUT; }

    public UUID getId() { return id; }
    public UUID getOperationRunId() { return operationRunId; }
    public UUID getStepRunId() { return stepRunId; }
    public String getProvider() { return provider; }
    public String getMode() { return mode; }
    public String getRepository() { return repository; }
    public String getWorkflow() { return workflow; }
    public String getRef() { return ref; }
    public String getExpectedHeadSha() { return expectedHeadSha; }
    public Long getExternalRunId() { return externalRunId; }
    public String getExternalUrl() { return externalUrl; }
    public Instant getCorrelationNotBefore() { return correlationNotBefore; }
    public Instant getDeadline() { return deadline; }
    public Status getStatus() { return status; }
    public String getLastObservedStatus() { return lastObservedStatus; }
    public String getLastObservedConclusion() { return lastObservedConclusion; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
