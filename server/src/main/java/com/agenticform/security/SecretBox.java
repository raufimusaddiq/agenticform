package com.agenticform.security;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

@Service
public class SecretBox {
    private static final int IV_BYTES = 12;
    private final byte[] key;
    private final SecureRandom random = new SecureRandom();

    public SecretBox(AgenticformProperties properties) {
        String configured = properties.getSecurity().getSecretKey();
        String material = configured == null || configured.isBlank() ? properties.getSecurity().getAdminToken() : configured;
        if (material == null || material.length() < 32) throw new IllegalStateException("SecretBox requires a 32-character secret");
        try {
            key = MessageDigest.getInstance("SHA-256").digest(material.getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) { throw new IllegalStateException("Invalid Agenticform secret key", error); }
    }

    public String encrypt(String plaintext) {
        try {
            byte[] iv = new byte[IV_BYTES]; random.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            return Base64.getEncoder().encodeToString(iv) + "."
                    + Base64.getEncoder().encodeToString(cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) { throw new IllegalStateException("Unable to encrypt Git credential", error); }
    }

    public String decrypt(String encoded) {
        try {
            String[] parts = encoded.split("\\.", 2);
            if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted secret");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                    new GCMParameterSpec(128, Base64.getDecoder().decode(parts[0])));
            return new String(cipher.doFinal(Base64.getDecoder().decode(parts[1])), StandardCharsets.UTF_8);
        } catch (Exception error) { throw new IllegalStateException("Unable to decrypt Git credential", error); }
    }
}
