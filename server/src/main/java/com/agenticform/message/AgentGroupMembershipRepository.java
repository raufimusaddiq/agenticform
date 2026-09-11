package com.agenticform.message;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface AgentGroupMembershipRepository extends JpaRepository<AgentGroupMembershipEntity, AgentGroupMembershipId> {
    List<AgentGroupMembershipEntity> findAllByGroupId(UUID groupId);
    List<AgentGroupMembershipEntity> findAllByAgentId(UUID agentId);
    void deleteAllByGroupId(UUID groupId);
}
