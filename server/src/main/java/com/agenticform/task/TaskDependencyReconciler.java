package com.agenticform.task;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class TaskDependencyReconciler {
    private final TaskRepository tasks;
    private final TaskDependencyService dependencies;

    public TaskDependencyReconciler(TaskRepository tasks, TaskDependencyService dependencies) {
        this.tasks = tasks;
        this.dependencies = dependencies;
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.reconcile-delay-ms:10000}")
    public void reconcileWaitingTasks() {
        for (TaskEntity task : tasks.findTop20ByStatusOrderByUpdatedAtAsc(TaskStatus.WAITING_DEPENDENCY)) {
            dependencies.reconcile(task.getId());
        }
    }
}
