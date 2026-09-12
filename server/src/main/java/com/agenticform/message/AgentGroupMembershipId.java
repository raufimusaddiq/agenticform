package com.agenticform.message;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

public class AgentGroupMembershipId implements Serializable {
    private UUID groupId;
    private UUID agentId;

    public AgentGroupMembershipId() {}
    public AgentGroupMembershipId(UUID groupId, UUID agentId) {
        this.groupId = groupId;
        this.agentId = agentId;
    }

    public UUID getGroupId() { return groupId; }
    public UUID getAgentId() { return agentId; }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof AgentGroupMembershipId that)) return false;
        return Objects.equals(groupId, that.groupId) && Objects.equals(agentId, that.agentId);
    }

    @Override
    public int hashCode() { return Objects.hash(groupId, agentId); }
}
