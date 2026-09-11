package com.agenticform.agent;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AgentRepository extends JpaRepository<AgentEntity, UUID> {
    List<AgentEntity> findAllByProjectId(UUID projectId);
    Optional<AgentEntity> findByCodexThreadId(String codexThreadId);
    Optional<AgentEntity> findByProjectIdAndRole(UUID projectId, AgentRole role);
}
