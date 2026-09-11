package com.agenticform.operation;

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
@Table(name = "operation_step_runs")
public class OperationStepRunEntity {
    public enum Status { RUNNING, WAITING_EXTERNAL, SUCCEEDED, FAILED }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "operation_run_id", nullable = false)
    private UUID operationRunId;

    @Column(name = "step_key", nullable = false, length = 64)
    private String stepKey;

    @Column(name = "step_name", nullable = false, length = 128)
    private String stepName;

    @Column(name = "step_type", nullable = false, length = 32)
    private String stepType;

    @Column(nullable = false)
    private int position;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status;

    @Column(columnDefinition = "text")
    private String summary;

    @Column(columnDefinition = "text")
    private String evidence;

    @Column(name = "exit_code")
    private Integer exitCode;

    @Column(name = "duration_ms")
    private Long durationMs;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    protected OperationStepRunEntity() {}

    public OperationStepRunEntity(UUID operationRunId, String stepKey, String stepName,
                                  String stepType, int position) {
        this.operationRunId = operationRunId;
        this.stepKey = stepKey;
        this.stepName = stepName;
        this.stepType = stepType;
        this.position = position;
        this.status = Status.RUNNING;
    }

    @PrePersist
    void onCreate() { startedAt = Instant.now(); }

    public void waitExternal(String summary) {
        this.status = Status.WAITING_EXTERNAL;
        this.summary = summary;
        this.completedAt = null;
    }

    public void succeed(String summary, String evidence, Integer exitCode, long durationMs) {
        this.status = Status.SUCCEEDED;
        this.summary = summary;
        this.evidence = evidence;
        this.exitCode = exitCode;
        this.durationMs = durationMs;
        this.completedAt = Instant.now();
    }

    public void fail(String summary, String evidence, Integer exitCode, long durationMs) {
        this.status = Status.FAILED;
        this.summary = summary;
        this.evidence = evidence;
        this.exitCode = exitCode;
        this.durationMs = durationMs;
        this.completedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getOperationRunId() { return operationRunId; }
    public String getStepKey() { return stepKey; }
    public String getStepName() { return stepName; }
    public String getStepType() { return stepType; }
    public int getPosition() { return position; }
    public Status getStatus() { return status; }
    public String getSummary() { return summary; }
    public String getEvidence() { return evidence; }
    public Integer getExitCode() { return exitCode; }
    public Long getDurationMs() { return durationMs; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getCompletedAt() { return completedAt; }
}
