package com.agenticform.message;

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
@Table(name = "communication_rules")
public class CommunicationRuleEntity {
    public enum Action { MESSAGE }
    public enum Effect { ALLOW, DENY }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "from_project_id", nullable = false)
    private UUID fromProjectId;

    @Column(name = "to_project_id", nullable = false)
    private UUID toProjectId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Action action;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Effect effect;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected CommunicationRuleEntity() {}

    public CommunicationRuleEntity(UUID fromProjectId, UUID toProjectId, Action action, Effect effect) {
        if (fromProjectId == null || toProjectId == null || fromProjectId.equals(toProjectId)) {
            throw new IllegalArgumentException("Communication rule requires two different projects");
        }
        this.fromProjectId = fromProjectId;
        this.toProjectId = toProjectId;
        this.action = action == null ? Action.MESSAGE : action;
        this.effect = effect == null ? Effect.DENY : effect;
    }

    @PrePersist
    void onCreate() { createdAt = updatedAt = Instant.now(); }

    @PreUpdate
    void onUpdate() { updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public UUID getFromProjectId() { return fromProjectId; }
    public UUID getToProjectId() { return toProjectId; }
    public Action getAction() { return action; }
    public Effect getEffect() { return effect; }
    public boolean isEnabled() { return enabled; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void update(Effect effect, boolean enabled) {
        this.effect = effect == null ? Effect.DENY : effect;
        this.enabled = enabled;
    }
}
