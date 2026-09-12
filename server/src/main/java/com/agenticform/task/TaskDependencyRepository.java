package com.agenticform.task;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface TaskDependencyRepository extends JpaRepository<TaskDependencyEntity, TaskDependencyId> {
    List<TaskDependencyEntity> findAllByTaskId(UUID taskId);
    List<TaskDependencyEntity> findAllByDependsOnTaskId(UUID dependsOnTaskId);
    boolean existsByTaskIdAndDependsOnTaskId(UUID taskId, UUID dependsOnTaskId);
}
