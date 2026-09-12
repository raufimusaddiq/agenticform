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
@Table(name = "operational_incidents")
public class OperationalIncidentEntity {
    public enum Status { OPEN, INVESTIGATING, MITIGATING, RESOLVED, SUPPRESSED }
    public enum WakeStatus { PENDING, QUEUED, DELIVERED, FAILED }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "incident_type", nullable = false, length = 128)
    private String incidentType;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private OperationalSeverity severity;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status = Status.OPEN;

    @Column(nullable = false, length = 255)
    private String fingerprint;

    @Column(nullable = false, length = 255)
    private String title;

    @Column(nullable = false, columnDefinition = "text")
    private String summary;

    @Column(name = "suspected_change", length = 255)
    private String suspectedChange;

    @Column(name = "operational_agent_id")
    private UUID operationalAgentId;

    @Enumerated(EnumType.STRING)
    @Column(name = "wake_status", nullable = false, length = 32)
    private WakeStatus wakeStatus = WakeStatus.PENDING;

    @Column(name = "wake_attempts", nullable = false)
    private int wakeAttempts;

    @Column(name = "wake_command_id")
    private UUID wakeCommandId;

    @Column(name = "queued_submission_id")
    private String queuedSubmissionId;

    @Column(name = "turn_id")
    private String turnId;

    @Column(name = "last_wake_error", columnDefinition = "text")
    private String lastWakeError;

    @Column(name = "resolution_summary", columnDefinition = "text")
    private String resolutionSummary;

    @Column(name = "first_seen_at", nullable = false)
    private Instant firstSeenAt;

    @Column(name = "last_seen_at", nullable = false)
    private Instant lastSeenAt;

    @Column(name = "resolved_at")
    private Instant resolvedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected OperationalIncidentEntity() {}

    public OperationalIncidentEntity(UUID projectId, String incidentType, OperationalSeverity severity,
                                     String fingerprint, String title, String summary, String suspectedChange,
                                     Instant observedAt) {
        this.projectId = projectId;
        this.incidentType = incidentType;
        this.severity = severity;
        this.fingerprint = fingerprint;
        this.title = title;
        this.summary = summary;
        this.suspectedChange = suspectedChange;
        this.firstSeenAt = observedAt;
        this.lastSeenAt = observedAt;
    }

    @PrePersist
    void onCreate() {
        createdAt = updatedAt = Instant.now();
        if (firstSeenAt == null) firstSeenAt = createdAt;
        if (lastSeenAt == null) lastSeenAt = firstSeenAt;
    }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public boolean observe(OperationalSeverity severity, String summary, String suspectedChange, Instant observedAt) {
        boolean escalated = severity != null && severity.higherThan(this.severity);
        if (escalated) {
            this.severity = severity;
            requestWakeForNewEvidence();
        }
        if (summary != null && !summary.isBlank()) this.summary = summary;
        if (suspectedChange != null && !suspectedChange.isBlank()) this.suspectedChange = suspectedChange;
        lastSeenAt = observedAt == null ? Instant.now() : observedAt;
        return escalated;
    }

    public void requestWakeForNewEvidence() {
        if (terminal()) return;
        if (wakeStatus == WakeStatus.DELIVERED || (wakeStatus == WakeStatus.FAILED && wakeCommandId == null)) {
            wakeStatus = WakeStatus.PENDING;
            wakeCommandId = null;
            wakeAttempts = 0;
            lastWakeError = null;
        }
    }

    public void setOperationalAgentId(UUID operationalAgentId) { this.operationalAgentId = operationalAgentId; }

    public void queued(UUID commandId) {
        wakeStatus = WakeStatus.QUEUED;
        wakeCommandId = commandId;
        wakeAttempts++;
        lastWakeError = null;
    }

    public void delivered(String queuedSubmissionId, String turnId) {
        boolean remoteAttempt = wakeCommandId != null;
        wakeStatus = WakeStatus.DELIVERED;
        this.queuedSubmissionId = queuedSubmissionId;
        this.turnId = turnId;
        lastWakeError = null;
        if (!remoteAttempt) wakeAttempts++;
    }

    public void wakeFailed(String error) {
        boolean remoteAttempt = wakeStatus == WakeStatus.QUEUED && wakeCommandId != null;
        wakeStatus = WakeStatus.FAILED;
        lastWakeError = error;
        if (!remoteAttempt) {
            wakeCommandId = null;
            wakeAttempts++;
        }
    }

    public void retryWake() {
        wakeStatus = WakeStatus.PENDING;
        wakeCommandId = null;
        lastWakeError = null;
    }

    public void transition(Status next, String resolutionSummary) {
        if (terminal() && next != status) {
            throw new IllegalStateException("Terminal incident cannot be reopened implicitly");
        }
        if ((next == Status.RESOLVED || next == Status.SUPPRESSED)
                && (resolutionSummary == null || resolutionSummary.isBlank())) {
            throw new IllegalArgumentException("Terminal incident status requires a resolution or suppression summary");
        }
        status = next;
        if (next == Status.RESOLVED) {
            this.resolutionSummary = resolutionSummary;
            resolvedAt = Instant.now();
        } else if (next == Status.SUPPRESSED) {
            this.resolutionSummary = resolutionSummary;
            resolvedAt = Instant.now();
        } else if (resolutionSummary != null && !resolutionSummary.isBlank()) {
            this.summary = resolutionSummary;
        }
    }

    public boolean terminal() { return status == Status.RESOLVED || status == Status.SUPPRESSED; }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public String getIncidentType() { return incidentType; }
    public OperationalSeverity getSeverity() { return severity; }
    public Status getStatus() { return status; }
    public String getFingerprint() { return fingerprint; }
    public String getTitle() { return title; }
    public String getSummary() { return summary; }
    public String getSuspectedChange() { return suspectedChange; }
    public UUID getOperationalAgentId() { return operationalAgentId; }
    public WakeStatus getWakeStatus() { return wakeStatus; }
    public int getWakeAttempts() { return wakeAttempts; }
    public UUID getWakeCommandId() { return wakeCommandId; }
    public String getQueuedSubmissionId() { return queuedSubmissionId; }
    public String getTurnId() { return turnId; }
    public String getLastWakeError() { return lastWakeError; }
    public String getResolutionSummary() { return resolutionSummary; }
    public Instant getFirstSeenAt() { return firstSeenAt; }
    public Instant getLastSeenAt() { return lastSeenAt; }
    public Instant getResolvedAt() { return resolvedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
