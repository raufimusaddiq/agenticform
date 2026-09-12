package com.agenticform.config;

import org.junit.jupiter.api.Test;

import java.net.URI;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SecurityStartupValidatorTest {
    @Test
    void localhostMayBootstrapWithoutAdminToken() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.setPublicUrl(URI.create("http://localhost:8080"));
        assertDoesNotThrow(() -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void remoteControlPlaneRequiresHttps() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.setPublicUrl(URI.create("http://agenticform.example.com"));
        properties.getSecurity().setAdminToken("01234567890123456789012345678901");
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void remoteControlPlaneRequiresAdminToken() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.setPublicUrl(URI.create("https://agenticform.example.com"));
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void weakAdminTokenIsRejected() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.setPublicUrl(URI.create("https://agenticform.example.com"));
        properties.getSecurity().setAdminToken("too-short");
        assertThrows(IllegalStateException.class, () -> new SecurityStartupValidator(properties).validate());
    }

    @Test
    void secureRemoteConfigurationPasses() {
        AgenticformProperties properties = new AgenticformProperties();
        properties.setPublicUrl(URI.create("https://agenticform.example.com"));
        properties.getSecurity().setAdminToken("01234567890123456789012345678901");
        assertDoesNotThrow(() -> new SecurityStartupValidator(properties).validate());
    }
}
