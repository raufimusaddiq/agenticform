package com.agenticform.operation;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class OperationalIncidentServiceTest {
    @Mock OperationalIncidentRepository incidents;
    @Mock OperationalSignalRepository signals;
    @Mock OperationalIncidentSignalRepository links;

    OperationalIncidentService service;

    @BeforeEach
    void setUp() {
        service = new OperationalIncidentService(incidents, signals, links, new ObjectMapper());
    }

    @Test
    void serviceHealthNeedsThreeOccurrencesBeforeOpeningIncident() {
        OperationalSignalEntity signal = signal("SERVICE_HEALTH_FAILURE", 2, "service:api:health");
        assertNull(service.correlate(signal));
        verify(incidents, never()).save(any());
    }

    @Test
    void thirdServiceHealthFailureOpensHighSeverityIncidentAndLinksEvidence() {
        UUID projectId = UUID.randomUUID();
        UUID signalId = UUID.randomUUID();
        OperationalSignalEntity signal = mock(OperationalSignalEntity.class);
        when(signal.getId()).thenReturn(signalId);
        when(signal.getProjectId()).thenReturn(projectId);
        when(signal.getSignalType()).thenReturn("SERVICE_HEALTH_FAILURE");
        when(signal.getOccurrenceCount()).thenReturn(3);
        when(signal.getCorrelationKey()).thenReturn("service:api:health");
        when(signal.getFingerprint()).thenReturn("service:api:health:failure");
        when(signal.getSeverity()).thenReturn(OperationalSeverity.WARNING);
        when(signal.getSource()).thenReturn(OperationalSignalSource.SERVICE_HEALTH);
        when(signal.getPayloadJson()).thenReturn("{}");
        when(signal.getLastSeenAt()).thenReturn(Instant.now());
        when(incidents.findFirstByProjectIdAndFingerprintAndStatusInOrderByUpdatedAtDesc(
                eq(projectId), eq("SERVICE_DEGRADED:service:api:health"), anyCollection()))
                .thenReturn(Optional.empty());

        OperationalIncidentEntity persisted = mock(OperationalIncidentEntity.class);
        UUID incidentId = UUID.randomUUID();
        when(persisted.getId()).thenReturn(incidentId);
        when(incidents.save(any(OperationalIncidentEntity.class))).thenReturn(persisted);
        when(links.existsByIncidentIdAndSignalId(incidentId, signalId)).thenReturn(false);

        OperationalIncidentEntity result = service.correlate(signal);

        assertSame(persisted, result);
        ArgumentCaptor<OperationalIncidentEntity> created = ArgumentCaptor.forClass(OperationalIncidentEntity.class);
        verify(incidents).save(created.capture());
        assertEquals("SERVICE_DEGRADED", created.getValue().getIncidentType());
        assertEquals(OperationalSeverity.HIGH, created.getValue().getSeverity());
        verify(links).save(any(OperationalIncidentSignalEntity.class));
        verify(signal).correlated();
        verify(signals).save(signal);
    }

    @Test
    void recoveryEvidenceAttachesToExistingServiceIncidentWithoutAutoResolvingIt() {
        UUID projectId = UUID.randomUUID();
        UUID signalId = UUID.randomUUID();
        OperationalSignalEntity recovery = mock(OperationalSignalEntity.class);
        when(recovery.getId()).thenReturn(signalId);
        when(recovery.getProjectId()).thenReturn(projectId);
        when(recovery.getSignalType()).thenReturn("SERVICE_HEALTH_RECOVERED");
        when(recovery.getCorrelationKey()).thenReturn("service:api:health");
        when(recovery.getLastSeenAt()).thenReturn(Instant.now());

        OperationalIncidentEntity incident = mock(OperationalIncidentEntity.class);
        UUID incidentId = UUID.randomUUID();
        when(incident.getId()).thenReturn(incidentId);
        when(incident.getSeverity()).thenReturn(OperationalSeverity.HIGH);
        when(incidents.findFirstByProjectIdAndFingerprintAndStatusInOrderByUpdatedAtDesc(
                eq(projectId), eq("SERVICE_DEGRADED:service:api:health"), anyCollection()))
                .thenReturn(Optional.of(incident));
        when(incidents.save(incident)).thenReturn(incident);
        when(links.existsByIncidentIdAndSignalId(incidentId, signalId)).thenReturn(false);

        assertSame(incident, service.correlate(recovery));
        verify(incident).observe(eq(OperationalSeverity.HIGH), any(), eq(null), any());
        verify(links).save(any(OperationalIncidentSignalEntity.class));
        verify(recovery).correlated();
        verify(incidents, never()).delete(any());
    }

    private OperationalSignalEntity signal(String type, int count, String correlationKey) {
        OperationalSignalEntity signal = mock(OperationalSignalEntity.class);
        when(signal.getSignalType()).thenReturn(type);
        when(signal.getOccurrenceCount()).thenReturn(count);
        when(signal.getCorrelationKey()).thenReturn(correlationKey);
        return signal;
    }
}
