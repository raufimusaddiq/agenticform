package com.agenticform.message;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "agent_group_memberships")
@IdClass(AgentGroupMembershipId.class)
public class AgentGroupMembershipEntity {
    @Id
    @Column(name = "group_id", nullable = false)
    private UUID groupId;

    @Id
    @Column(name = "agent_id", nullable = false)
    private UUID agentId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected AgentGroupMembershipEntity() {}

    public AgentGroupMembershipEntity(UUID groupId, UUID agentId) {
        this.groupId = groupId;
        this.agentId = agentId;
    }

    @PrePersist
    void onCreate() { createdAt = Instant.now(); }

    public UUID getGroupId() { return groupId; }
    public UUID getAgentId() { return agentId; }
    public Instant getCreatedAt() { return createdAt; }
}
