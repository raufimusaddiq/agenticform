package com.agenticform.config;

import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

@Component
public class SecurityStartupValidator {
    private static final Set<String> LOOPBACK_HOSTS = Set.of("localhost", "127.0.0.1", "::1");
    private static final Pattern IMAGE_DIGEST = Pattern.compile("^.+@sha256:[0-9a-fA-F]{64}$");

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
        if (publicUrl.getUserInfo() != null || publicUrl.getQuery() != null || publicUrl.getFragment() != null
                || (publicUrl.getPath() != null && !publicUrl.getPath().isBlank() && !"/".equals(publicUrl.getPath()))) {
            throw new IllegalStateException("agenticform.public-url must be a clean origin without credentials, path, query, or fragment");
        }
        String scheme = publicUrl.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            throw new IllegalStateException("agenticform.public-url must use http or https");
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

        if (!local) {
            String nodeImage = properties.getNode().getImage();
            if (nodeImage == null || !IMAGE_DIGEST.matcher(nodeImage.trim()).matches()) {
                throw new IllegalStateException(
                        "AGENTICFORM_NODE_IMAGE must use an immutable @sha256 digest for a non-local control plane");
            }
        }
    }
}
