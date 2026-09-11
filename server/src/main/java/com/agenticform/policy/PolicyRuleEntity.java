package com.agenticform.policy;

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
@Table(name = "policy_rules")
public class PolicyRuleEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Enumerated(EnumType.STRING)
    @Column(name = "scope_type", nullable = false)
    private PolicyScopeType scopeType;

    @Column(name = "scope_id")
    private UUID scopeId;

    @Column(nullable = false, length = 128)
    private String action;

    @Column(nullable = false, length = 64)
    private String environment;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private PolicyEffect effect;

    @Column(nullable = false, columnDefinition = "text")
    private String description;

    @Column(nullable = false)
    private boolean enabled;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected PolicyRuleEntity() {}

    public PolicyRuleEntity(PolicyScopeType scopeType, UUID scopeId, String action, String environment,
                            PolicyEffect effect, String description, boolean enabled) {
        this.scopeType = scopeType;
        this.scopeId = scopeId;
        this.action = action;
        this.environment = environment;
        this.effect = effect;
        this.description = description;
        this.enabled = enabled;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public PolicyScopeType getScopeType() { return scopeType; }
    public UUID getScopeId() { return scopeId; }
    public String getAction() { return action; }
    public String getEnvironment() { return environment; }
    public PolicyEffect getEffect() { return effect; }
    public String getDescription() { return description; }
    public boolean isEnabled() { return enabled; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void update(PolicyScopeType scopeType, UUID scopeId, String action, String environment,
                       PolicyEffect effect, String description, boolean enabled) {
        this.scopeType = scopeType;
        this.scopeId = scopeId;
        this.action = action;
        this.environment = environment;
        this.effect = effect;
        this.description = description;
        this.enabled = enabled;
    }
}
