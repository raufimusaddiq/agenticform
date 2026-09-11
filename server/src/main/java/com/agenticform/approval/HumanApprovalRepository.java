package com.agenticform.approval;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface HumanApprovalRepository extends JpaRepository<HumanApprovalEntity, UUID> {
    List<HumanApprovalEntity> findAllByOrderByCreatedAtDesc();
    List<HumanApprovalEntity> findAllByProjectIdOrderByCreatedAtDesc(UUID projectId);
    List<HumanApprovalEntity> findAllByStatusOrderByCreatedAtDesc(HumanApprovalStatus status);
    List<HumanApprovalEntity> findAllByProjectIdAndStatusOrderByCreatedAtDesc(UUID projectId, HumanApprovalStatus status);
    boolean existsByAgentIdAndStatus(UUID agentId, HumanApprovalStatus status);
    List<HumanApprovalEntity> findAllByStatus(HumanApprovalStatus status);
}
