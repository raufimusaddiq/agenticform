package com.agenticform.workspace;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface WorkspaceCleanupRecordRepository extends JpaRepository<WorkspaceCleanupRecordEntity, UUID> {
    List<WorkspaceCleanupRecordEntity> findAllByProjectIdOrderByCreatedAtDesc(UUID projectId);
}
