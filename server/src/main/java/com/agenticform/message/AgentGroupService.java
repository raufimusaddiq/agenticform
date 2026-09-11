package com.agenticform.message;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class AgentGroupService {
    public record GroupDetail(AgentGroupEntity group, List<UUID> memberAgentIds) {}

    private final AgentGroupRepository groups;
    private final AgentGroupMembershipRepository memberships;
    private final AgentRepository agents;

    public AgentGroupService(AgentGroupRepository groups,
                             AgentGroupMembershipRepository memberships,
                             AgentRepository agents) {
        this.groups = groups;
        this.memberships = memberships;
        this.agents = agents;
    }

    public List<GroupDetail> list(UUID projectId) {
        return groups.findAllByProjectIdOrderByName(projectId).stream().map(this::detail).toList();
    }

    @Transactional
    public GroupDetail create(UUID projectId, String name, List<UUID> memberAgentIds) {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("Group name is required");
        String normalized = name.trim();
        if (normalized.length() > 128) throw new IllegalArgumentException("Group name is too long");
        if (groups.findByProjectIdAndName(projectId, normalized).isPresent()) {
            throw new IllegalArgumentException("Agent group already exists: " + normalized);
        }
        AgentGroupEntity group = groups.save(new AgentGroupEntity(projectId, normalized));
        replaceMembers(group, memberAgentIds);
        return detail(group);
    }

    @Transactional
    public GroupDetail replaceMembers(UUID groupId, List<UUID> memberAgentIds) {
        AgentGroupEntity group = groups.findById(groupId)
                .orElseThrow(() -> new NoSuchElementException("Agent group not found: " + groupId));
        replaceMembers(group, memberAgentIds);
        return detail(group);
    }

    @Transactional
    public void delete(UUID groupId) {
        AgentGroupEntity group = groups.findById(groupId)
                .orElseThrow(() -> new NoSuchElementException("Agent group not found: " + groupId));
        memberships.deleteAllByGroupId(group.getId());
        groups.delete(group);
    }

    private void replaceMembers(AgentGroupEntity group, List<UUID> ids) {
        memberships.deleteAllByGroupId(group.getId());
        if (ids == null) return;
        ids.stream().distinct().forEach(agentId -> {
            AgentEntity agent = agents.findById(agentId)
                    .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
            if (!group.getProjectId().equals(agent.getProjectId())) {
                throw new IllegalArgumentException("Agent group cannot contain an agent from another project");
            }
            memberships.save(new AgentGroupMembershipEntity(group.getId(), agentId));
        });
    }

    private GroupDetail detail(AgentGroupEntity group) {
        return new GroupDetail(group, memberships.findAllByGroupId(group.getId()).stream()
                .map(AgentGroupMembershipEntity::getAgentId).toList());
    }
}
