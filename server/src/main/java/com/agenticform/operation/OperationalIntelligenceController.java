package com.agenticform.operation;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/operational-intelligence")
public class OperationalIntelligenceController {
    private final OperationalSignalService signals;
    private final OperationalIncidentService incidents;

    public OperationalIntelligenceController(OperationalSignalService signals,
                                             OperationalIncidentService incidents) {
        this.signals = signals;
        this.incidents = incidents;
    }

    @GetMapping("/signals")
    public List<OperationalSignalEntity> signals(@RequestParam(required = false) UUID projectId,
                                                  @RequestParam(required = false) OperationalSignalEntity.Status status) {
        return signals.list(projectId, status);
    }

    @PostMapping("/signals")
    public OperationalSignalService.SignalResult record(@Valid @RequestBody RecordSignalRequest request) {
        return signals.record(new OperationalSignalService.SignalInput(
                request.projectId(), request.source(), request.signalType(), request.severity(),
                request.fingerprint(), request.correlationKey(), request.payload(), request.observedAt()));
    }

    @GetMapping("/incidents")
    public List<OperationalIncidentEntity> incidents(@RequestParam(required = false) UUID projectId,
                                                      @RequestParam(required = false) OperationalIncidentEntity.Status status) {
        return incidents.list(projectId, status);
    }

    @GetMapping("/incidents/{incidentId}")
    public OperationalIncidentService.IncidentDetail incident(@PathVariable UUID incidentId) {
        return incidents.detail(incidentId);
    }

    @PostMapping("/incidents/{incidentId}/status")
    public OperationalIncidentEntity transition(@PathVariable UUID incidentId,
                                                 @Valid @RequestBody TransitionIncidentRequest request) {
        return incidents.transition(incidentId, request.status(), request.summary());
    }

    @PostMapping("/incidents/{incidentId}/retry-wake")
    public OperationalIncidentEntity retryWake(@PathVariable UUID incidentId) {
        return incidents.retryWake(incidentId);
    }

    public record RecordSignalRequest(
            @NotNull UUID projectId,
            @NotNull OperationalSignalSource source,
            @NotBlank String signalType,
            OperationalSeverity severity,
            @NotBlank String fingerprint,
            String correlationKey,
            Map<String, ?> payload,
            Instant observedAt
    ) {}

    public record TransitionIncidentRequest(@NotNull OperationalIncidentEntity.Status status, String summary) {}
}
