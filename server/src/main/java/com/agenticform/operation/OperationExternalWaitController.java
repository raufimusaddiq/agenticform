package com.agenticform.operation;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@RestController
@RequestMapping("/api/operations/runs")
public class OperationExternalWaitController {
    private final OperationRunRepository runRepository;
    private final OperationExternalWaitRepository waitRepository;

    public OperationExternalWaitController(OperationRunRepository runRepository,
                                           OperationExternalWaitRepository waitRepository) {
        this.runRepository = runRepository;
        this.waitRepository = waitRepository;
    }

    @GetMapping("/{runId}/external-waits")
    public List<OperationExternalWaitEntity> externalWaits(@PathVariable UUID runId) {
        if (!runRepository.existsById(runId)) {
            throw new NoSuchElementException("Operation run not found: " + runId);
        }
        return waitRepository.findAllByOperationRunIdOrderByCreatedAtAsc(runId);
    }
}
