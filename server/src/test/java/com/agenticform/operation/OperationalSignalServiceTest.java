package com.agenticform.operation;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class OperationalSignalServiceTest {
    @Mock OperationalSignalRepository repository;
    @Mock OperationalIncidentService incidents;

    OperationalSignalService service;

    @BeforeEach
    void setUp() {
        service = new OperationalSignalService(repository, incidents, new ObjectMapper());
    }

    @Test
    void repeatedFingerprintUpdatesExistingSignalInsteadOfCreatingAnotherRow() {
        UUID projectId = UUID.randomUUID();
        OperationalSignalEntity existing = mock(OperationalSignalEntity.class);
        OperationalIncidentEntity incident = mock(OperationalIncidentEntity.class);
        when(repository.findFirstByProjectIdAndFingerprintAndStatusInOrderByLastSeenAtDesc(
                eq(projectId), eq("service:api:health:failure"), anyCollection()))
                .thenReturn(Optional.of(existing));
        when(repository.save(existing)).thenReturn(existing);
        when(incidents.correlate(existing)).thenReturn(incident);

        var result = service.record(new OperationalSignalService.SignalInput(
                projectId, OperationalSignalSource.SERVICE_HEALTH, "SERVICE_HEALTH_FAILURE",
                OperationalSeverity.WARNING, "service:api:health:failure", "service:api:health",
                Map.of("statusCode", 503), Instant.parse("2026-09-12T05:00:00Z")));

        verify(existing).observe(eq(OperationalSeverity.WARNING), any(), eq(Instant.parse("2026-09-12T05:00:00Z")));
        assertSame(existing, result.signal());
        assertSame(incident, result.incident());
    }

    @Test
    void recoveryClosesActiveFailureAndCreatesDurableRecoveryEvidence() {
        UUID projectId = UUID.randomUUID();
        UUID failureId = UUID.randomUUID();
        OperationalSignalEntity failure = mock(OperationalSignalEntity.class);
        when(failure.getId()).thenReturn(failureId);
        when(repository.findFirstByProjectIdAndFingerprintAndStatusInOrderByLastSeenAtDesc(
                eq(projectId), eq("service:api:health:failure"), anyCollection()))
                .thenReturn(Optional.of(failure));
        when(repository.save(any(OperationalSignalEntity.class))).thenAnswer(invocation -> invocation.getArgument(0));
        OperationalIncidentEntity incident = mock(OperationalIncidentEntity.class);
        when(incidents.correlate(any(OperationalSignalEntity.class))).thenReturn(incident);

        var result = service.recover(
                projectId, OperationalSignalSource.SERVICE_HEALTH,
                "service:api:health:failure", "service:api:health",
                Map.of("statusCode", 200), Instant.parse("2026-09-12T05:01:00Z"));

        verify(failure).resolve();
        assertEquals("SERVICE_HEALTH_RECOVERED", result.signal().getSignalType());
        assertEquals("service:api:health:failure:recovered:" + failureId, result.signal().getFingerprint());
        assertSame(incident, result.incident());
    }
}
