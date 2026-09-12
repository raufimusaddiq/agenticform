package com.agenticform.config;

import org.junit.jupiter.api.Test;

import java.net.URI;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SecurityStartupValidatorTest {
    private static final String ADMIN_TOKEN = "01234567890123456789012345678901";
    private static final String IMMUTABLE_IMAGE = "ghcr.io/raufimusaddiq/agenticform-node@sha256:"
            + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    void localhostStillRequiresAdminToken() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.setPublicUrl(URI.create("http://localhost:8080"));
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());

        properties.getSecurity().setAdminToken(ADMIN_TOKEN);
        assertDoesNotThrow(() -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void remoteControlPlaneRequiresHttps() {
        AgenticformProperties properties = secureRemoteProperties();
        properties.setPublicUrl(URI.create("http://agenticform.example.com"));
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void remoteControlPlaneRequiresAdminToken() {
        AgenticformProperties properties = secureRemoteProperties();
        properties.getSecurity().setAdminToken("");
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void weakAdminTokenIsRejected() {
        AgenticformProperties properties = secureRemoteProperties();
        properties.getSecurity().setAdminToken("too-short");
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void remoteControlPlaneRejectsMutableNodeImageTag() {
        AgenticformProperties properties = secureRemoteProperties();
        properties.getNode().setImage("ghcr.io/raufimusaddiq/agenticform-node:latest");
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void publicUrlRejectsCredentialsPathQueryAndFragment() {
        for (String value : new String[]{
                "https://user:secret@agenticform.example.com",
                "https://agenticform.example.com/control-plane",
                "https://agenticform.example.com?token=secret",
                "https://agenticform.example.com/#fragment"
        }) {
            AgenticformProperties properties = secureRemoteProperties();
            properties.setPublicUrl(URI.create(value));
            assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate(), value);
        }
    }

    @Test
    void unsupportedPublicUrlSchemeIsRejected() {
        AgenticformProperties properties = secureRemoteProperties();
        properties.setPublicUrl(URI.create("ftp://agenticform.example.com"));
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void secureRemoteConfigurationPasses() {
        AgenticformProperties properties = secureRemoteProperties();
        assertDoesNotThrow(() -> new SecurityStartupValidator(properties).validate());
    }

    private AgenticformProperties secureRemoteProperties() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.setPublicUrl(URI.create("https://agenticform.example.com"));
        properties.getSecurity().setAdminToken(ADMIN_TOKEN);
        properties.getNode().setImage(IMMUTABLE_IMAGE);
        return properties;
    }
}
