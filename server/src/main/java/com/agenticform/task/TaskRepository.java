package com.agenticform.task;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TaskRepository extends JpaRepository<TaskEntity, UUID> {
    List<TaskEntity> findTop20ByStatusOrderByPriorityDescCreatedAtAsc(TaskStatus status);
    List<TaskEntity> findTop20ByStatusOrderByUpdatedAtAsc(TaskStatus status);
    List<TaskEntity> findAllByProjectIdOrderByCreatedAtDesc(UUID projectId);
    List<TaskEntity> findAllByAssignedAgentIdOrderByCreatedAtAsc(UUID assignedAgentId);
    Optional<TaskEntity> findByCodexTurnId(String codexTurnId);
    boolean existsByAssignedAgentIdAndStatusIn(UUID agentId, Collection<TaskStatus> statuses);
}
