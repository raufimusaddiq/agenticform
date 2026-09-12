package com.agenticform.policy;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

public final class PolicyEffectFingerprint {
    private PolicyEffectFingerprint() {}

    public static String digest(String action, String environment, String effectKey) {
        if (effectKey == null || effectKey.isBlank()) return null;
        String canonical = normalize(action, "*") + "\n"
                + normalize(environment, "*") + "\n"
                + effectKey.trim();
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static String normalize(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value.trim();
    }
}
