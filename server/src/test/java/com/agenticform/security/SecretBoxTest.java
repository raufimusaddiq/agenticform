package com.agenticform.security;

import com.agenticform.config.AgenticformProperties;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class SecretBoxTest {
    private static final String ORIGINAL = "original-admin-token-at-least-32-characters";
    private static final String ROTATED = "rotated-admin-token-at-least-32-characters";
    private static final String SEPARATE = "separate-encryption-key-at-least-32-characters";

    private SecretBox box(String admin, String key) {
        AgenticformProperties properties = new AgenticformProperties();
        properties.getSecurity().setAdminToken(admin);
        properties.getSecurity().setSecretKey(key);
        return new SecretBox(properties);
    }

    @Test
    void separateKeySurvivesAdminRotation() {
        String encrypted = box(ORIGINAL, SEPARATE).encrypt("test-credential");
        assertEquals("test-credential", box(ROTATED, SEPARATE).decrypt(encrypted));
    }

    @Test
    void legacyKeyCanBePinnedBeforeAdminRotation() {
        String encrypted = box(ORIGINAL, "").encrypt("test-credential");
        assertEquals("test-credential", box(ROTATED, ORIGINAL).decrypt(encrypted));
    }

    @Test
    void wrongKeyFailsClosedWithRecoveryAction() {
        String encrypted = box(ORIGINAL, "").encrypt("test-credential");
        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> box(ROTATED, "").decrypt(encrypted));
        assertTrue(error.getMessage().contains("restore the original AGENTICFORM_SECRET_KEY"));
        assertFalse(error.getMessage().contains("test-credential"));
    }

    @Test
    void malformedCiphertextFailsClosed() {
        assertThrows(IllegalStateException.class, () -> box(ORIGINAL, SEPARATE).decrypt("invalid"));
    }
}
