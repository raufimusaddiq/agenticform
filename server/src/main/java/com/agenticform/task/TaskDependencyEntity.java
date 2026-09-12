package com.agenticform.task;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "task_dependencies")
@IdClass(TaskDependencyId.class)
public class TaskDependencyEntity {
    @Id
    @Column(name = "task_id", nullable = false)
    private UUID taskId;

    @Id
    @Column(name = "depends_on_task_id", nullable = false)
    private UUID dependsOnTaskId;

    @Enumerated(EnumType.STRING)
    @Column(name = "dependency_type", nullable = false, length = 32)
    private TaskDependencyType dependencyType;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected TaskDependencyEntity() {}

    public TaskDependencyEntity(UUID taskId, UUID dependsOnTaskId, TaskDependencyType dependencyType) {
        this.taskId = taskId;
        this.dependsOnTaskId = dependsOnTaskId;
        this.dependencyType = dependencyType == null ? TaskDependencyType.REQUIRES_SUCCESS : dependencyType;
    }

    @PrePersist
    void onCreate() { createdAt = Instant.now(); }

    public UUID getTaskId() { return taskId; }
    public UUID getDependsOnTaskId() { return dependsOnTaskId; }
    public TaskDependencyType getDependencyType() { return dependencyType; }
    public Instant getCreatedAt() { return createdAt; }
}
