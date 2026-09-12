package com.agenticform.message;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AgentGroupRepository extends JpaRepository<AgentGroupEntity, UUID> {
    List<AgentGroupEntity> findAllByProjectIdOrderByName(UUID projectId);
    Optional<AgentGroupEntity> findByProjectIdAndName(UUID projectId, String name);
}
