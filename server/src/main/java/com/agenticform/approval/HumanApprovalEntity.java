package com.agenticform.approval;

import com.agenticform.agent.HumanControlMode;
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
@Table(name = "human_approvals")
public class HumanApprovalEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "project_id", nullable = false)
    private UUID projectId;

    @Column(name = "agent_id", nullable = false)
    private UUID agentId;

    @Column(name = "codex_request_id", nullable = false)
    private String codexRequestId;

    @Column(nullable = false)
    private String method;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private HumanApprovalType type;

    @Enumerated(EnumType.STRING)
    @Column(name = "control_mode", nullable = false)
    private HumanControlMode controlMode;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private HumanApprovalRisk risk;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private HumanApprovalStatus status;

    @Column(name = "thread_id", nullable = false)
    private String threadId;

    @Column(name = "turn_id")
    private String turnId;

    @Column(name = "item_id")
    private String itemId;

    @Column(nullable = false, columnDefinition = "text")
    private String summary;

    @Column(name = "policy_action", length = 128)
    private String policyAction;

    @Column(name = "policy_environment", length = 64)
    private String policyEnvironment;

    @Enumerated(EnumType.STRING)
    @Column(name = "policy_effect", length = 32)
    private PolicyEffect policyEffect;

    @Column(name = "policy_rule_id")
    private UUID policyRuleId;

    @Column(name = "request_payload", nullable = false, columnDefinition = "text")
    private String requestPayload;

    @Column(name = "response_payload", columnDefinition = "text")
    private String responsePayload;

    @Column(name = "last_error", columnDefinition = "text")
    private String lastError;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "resolved_at")
    private Instant resolvedAt;

    protected HumanApprovalEntity() {}

    public HumanApprovalEntity(UUID projectId, UUID agentId, String codexRequestId, String method,
                               HumanApprovalType type, HumanControlMode controlMode, HumanApprovalRisk risk,
                               HumanApprovalStatus status, String threadId, String turnId, String itemId,
                               String summary, String requestPayload) {
        this.projectId = projectId;
        this.agentId = agentId;
        this.codexRequestId = codexRequestId;
        this.method = method;
        this.type = type;
        this.controlMode = controlMode;
        this.risk = risk;
        this.status = status;
        this.threadId = threadId;
        this.turnId = turnId;
        this.itemId = itemId;
        this.summary = summary;
        this.requestPayload = requestPayload;
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public UUID getAgentId() { return agentId; }
    public String getCodexRequestId() { return codexRequestId; }
    public String getMethod() { return method; }
    public HumanApprovalType getType() { return type; }
    public HumanControlMode getControlMode() { return controlMode; }
    public HumanApprovalRisk getRisk() { return risk; }
    public HumanApprovalStatus getStatus() { return status; }
    public String getThreadId() { return threadId; }
    public String getTurnId() { return turnId; }
    public String getItemId() { return itemId; }
    public String getSummary() { return summary; }
    public String getPolicyAction() { return policyAction; }
    public String getPolicyEnvironment() { return policyEnvironment; }
    public PolicyEffect getPolicyEffect() { return policyEffect; }
    public UUID getPolicyRuleId() { return policyRuleId; }
    public String getRequestPayload() { return requestPayload; }
    public String getResponsePayload() { return responsePayload; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getResolvedAt() { return resolvedAt; }

    public void attachPolicy(String action, String environment, PolicyEffect effect, UUID ruleId) {
        this.policyAction = action;
        this.policyEnvironment = environment;
        this.policyEffect = effect;
        this.policyRuleId = ruleId;
    }

    public void resolve(HumanApprovalStatus status, String responsePayload) {
        this.status = status;
        this.responsePayload = responsePayload;
        this.lastError = null;
        this.resolvedAt = Instant.now();
    }

    public void fail(String error) {
        this.status = HumanApprovalStatus.FAILED;
        this.lastError = error;
        this.resolvedAt = Instant.now();
    }

    public void orphan() {
        this.status = HumanApprovalStatus.ORPHANED;
        this.lastError = "Agenticform restarted before the Codex server request was resolved";
        this.resolvedAt = Instant.now();
    }
}
