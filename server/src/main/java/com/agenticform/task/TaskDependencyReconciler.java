package com.agenticform.task;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class TaskDependencyReconciler {
    private final TaskRepository tasks;
    private final TaskDependencyService dependencies;
    private final TaskDispatchService dispatch;

    public TaskDependencyReconciler(TaskRepository tasks, TaskDependencyService dependencies,
                                    TaskDispatchService dispatch) {
        this.tasks = tasks;
        this.dependencies = dependencies;
        this.dispatch = dispatch;
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.reconcile-delay-ms:10000}")
    public void reconcileWaitingTasks() {
        for (TaskEntity task : tasks.findTop20ByStatusOrderByUpdatedAtAsc(TaskStatus.WAITING_DEPENDENCY)) {
            if (task.getKind() == TaskKind.ORCHESTRATION
                    && task.getLastError() != null
                    && task.getLastError().startsWith("Waiting for delegated tasks")) {
                dispatch.reconcileOrchestration(task.getId());
            } else {
                dependencies.reconcile(task.getId());
            }
        }
    }
}
