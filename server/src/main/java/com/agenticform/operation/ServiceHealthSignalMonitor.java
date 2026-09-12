package com.agenticform.operation;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;

@Service
public class ServiceHealthSignalMonitor {
    private final OperationalServiceRepository services;
    private final OperationalSignalService signals;
    private final HttpClient client;

    public ServiceHealthSignalMonitor(OperationalServiceRepository services,
                                      OperationalSignalService signals) {
        this.services = services;
        this.signals = signals;
        this.client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    @Scheduled(fixedDelayString = "${agenticform.scheduler.service-health-delay-ms:30000}")
    public void probeRegisteredServices() {
        for (OperationalServiceEntity service : services.findAll()) {
            if (!service.isEnabled()) continue;
            probe(service, "health", service.getHealthUrl());
            probe(service, "readiness", service.getReadinessUrl());
        }
    }

    private void probe(OperationalServiceEntity service, String probe, String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) return;
        String fingerprint = "service:" + service.getId() + ":" + probe + ":failure";
        String correlationKey = "service:" + service.getId() + ":" + probe;
        Instant observedAt = Instant.now();
        try {
            URI uri = safeUri(rawUrl);
            HttpRequest request = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofSeconds(8))
                    .header("User-Agent", "Agenticform-HealthMonitor/1")
                    .GET()
                    .build();
            HttpResponse<Void> response = client.send(request, HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() >= 200 && response.statusCode() <= 299) {
                signals.recover(service.getProjectId(), OperationalSignalSource.SERVICE_HEALTH,
                        fingerprint, correlationKey,
                        evidence(service, probe, safeUrl(uri), response.statusCode(), null), observedAt);
                return;
            }
            signals.record(new OperationalSignalService.SignalInput(
                    service.getProjectId(), OperationalSignalSource.SERVICE_HEALTH,
                    "SERVICE_HEALTH_FAILURE", OperationalSeverity.WARNING,
                    fingerprint, correlationKey,
                    evidence(service, probe, safeUrl(uri), response.statusCode(), "unexpected HTTP status"), observedAt));
        } catch (Exception error) {
            signals.record(new OperationalSignalService.SignalInput(
                    service.getProjectId(), OperationalSignalSource.SERVICE_HEALTH,
                    "SERVICE_HEALTH_FAILURE", OperationalSeverity.WARNING,
                    fingerprint, correlationKey,
                    evidence(service, probe, safeUrl(rawUrl), null, safeError(error)), observedAt));
        }
    }

    private Map<String, ?> evidence(OperationalServiceEntity service, String probe, String url,
                                    Integer statusCode, String error) {
        return Map.of(
                "serviceId", service.getId().toString(),
                "serviceKey", service.getKey(),
                "serviceName", service.getDisplayName(),
                "environmentId", service.getEnvironmentId().toString(),
                "probe", probe,
                "url", url,
                "statusCode", statusCode == null ? 0 : statusCode,
                "error", error == null ? "" : error);
    }

    private URI safeUri(String value) {
        URI uri = URI.create(value);
        if (uri.getScheme() == null || (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme()))) {
            throw new IllegalArgumentException("Service health URL must use http or https");
        }
        if (uri.getHost() == null || uri.getUserInfo() != null) {
            throw new IllegalArgumentException("Service health URL requires a credential-free host");
        }
        return uri;
    }

    private String safeUrl(URI uri) {
        return uri.getScheme() + "://" + uri.getRawAuthority() + (uri.getRawPath() == null ? "" : uri.getRawPath());
    }

    private String safeUrl(String value) {
        try { return safeUrl(safeUri(value)); }
        catch (Exception ignored) { return "invalid-url"; }
    }

    private String safeError(Throwable error) {
        String value = error.getMessage();
        if (value == null || value.isBlank()) value = error.getClass().getSimpleName();
        return value.length() > 500 ? value.substring(0, 500) + "…" : value;
    }
}
