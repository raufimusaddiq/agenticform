package com.agenticform.operation;

import jakarta.annotation.PreDestroy;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Component
public class OperationExecutionScheduler {
    private final OperationRunRepository repository;
    private final RunbookExecutor executor;
    private final Set<UUID> inFlight = ConcurrentHashMap.newKeySet();
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();

    public OperationExecutionScheduler(OperationRunRepository repository, RunbookExecutor executor) {
        this.repository = repository;
        this.executor = executor;
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.operation-run-delay-ms:1000}")
    public void dispatchQueued() {
        for (OperationRunEntity run : repository.findAllByStatusIn(List.of(OperationRunEntity.Status.QUEUED))) {
            if (!inFlight.add(run.getId())) continue;
            workers.submit(() -> {
                try {
                    executor.execute(run.getId());
                } finally {
                    inFlight.remove(run.getId());
                }
            });
        }
    }

    @PreDestroy
    void close() {
        workers.shutdownNow();
    }
}
