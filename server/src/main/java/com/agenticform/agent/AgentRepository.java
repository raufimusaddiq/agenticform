package com.agenticform.agent;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AgentRepository extends JpaRepository<AgentEntity, UUID> {
    List<AgentEntity> findAllByProjectId(UUID projectId);
    List<AgentEntity> findAllByExecutionNodeId(UUID executionNodeId);
    long countByExecutionNodeIdAndStatusIn(UUID executionNodeId, Collection<AgentStatus> statuses);
    Optional<AgentEntity> findByCodexThreadId(String codexThreadId);
    Optional<AgentEntity> findByProjectIdAndRole(UUID projectId, AgentRole role);
}
