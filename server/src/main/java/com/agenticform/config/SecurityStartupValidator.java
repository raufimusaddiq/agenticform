package com.agenticform.config;

import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.Locale;
import java.util.Set;

@Component
public class SecurityStartupValidator {
    private static final Set<String> LOOPBACK_HOSTS = Set.of("localhost", "127.0.0.1", "::1");

    private final AgenticformProperties properties;

    public SecurityStartupValidator(AgenticformProperties properties) {
        this.properties = properties;
    }

    @PostConstruct
    void validate() {
        URI publicUrl = properties.getPublicUrl();
        if (publicUrl == null || publicUrl.getHost() == null) {
            throw new IllegalStateException("agenticform.public-url must be an absolute URL");
        }
        String host = publicUrl.getHost().toLowerCase(Locale.ROOT);
        boolean local = LOOPBACK_HOSTS.contains(host);
        if (!local && !"https".equalsIgnoreCase(publicUrl.getScheme())) {
            throw new IllegalStateException("Non-local Agenticform public URL must use HTTPS");
        }

        String adminToken = properties.getSecurity().getAdminToken();
        if (!local && (adminToken == null || adminToken.isBlank())) {
            throw new IllegalStateException("AGENTICFORM_ADMIN_TOKEN is required for a non-local control plane");
        }
        if (adminToken != null && !adminToken.isBlank() && adminToken.length() < 32) {
            throw new IllegalStateException("AGENTICFORM_ADMIN_TOKEN must be at least 32 characters");
        }
    }
}
