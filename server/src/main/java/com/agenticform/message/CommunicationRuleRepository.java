package com.agenticform.message;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface CommunicationRuleRepository extends JpaRepository<CommunicationRuleEntity, UUID> {
    Optional<CommunicationRuleEntity> findByFromProjectIdAndToProjectIdAndAction(
            UUID fromProjectId, UUID toProjectId, CommunicationRuleEntity.Action action);
    List<CommunicationRuleEntity> findAllByOrderByCreatedAtAsc();
}
