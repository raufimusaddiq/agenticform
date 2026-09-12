package com.agenticform.task;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

public class TaskDependencyId implements Serializable {
    private UUID taskId;
    private UUID dependsOnTaskId;

    public TaskDependencyId() {}

    public TaskDependencyId(UUID taskId, UUID dependsOnTaskId) {
        this.taskId = taskId;
        this.dependsOnTaskId = dependsOnTaskId;
    }

    public UUID getTaskId() { return taskId; }
    public UUID getDependsOnTaskId() { return dependsOnTaskId; }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof TaskDependencyId that)) return false;
        return Objects.equals(taskId, that.taskId) && Objects.equals(dependsOnTaskId, that.dependsOnTaskId);
    }

    @Override
    public int hashCode() { return Objects.hash(taskId, dependsOnTaskId); }
}
