package com.agenticform.task;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class TaskDispatchScheduler {
    private final TaskDispatchService dispatchService;

    public TaskDispatchScheduler(TaskDispatchService dispatchService) {
        this.dispatchService = dispatchService;
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.dispatch-delay-ms:2000}")
    public void dispatch() {
        dispatchService.dispatchReadyTasks();
    }
}
