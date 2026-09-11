package com.agenticform.node;

import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;

@Service
public class NodeSignatureVerifier {
    private static final Duration MAX_CLOCK_SKEW = Duration.ofMinutes(5);
    private final ExecutionNodeRepository nodes;

    public NodeSignatureVerifier(ExecutionNodeRepository nodes) {
        this.nodes = nodes;
    }

    public ExecutionNodeEntity verify(UUID nodeId, String timestamp, String signatureBase64,
                                      String method, String path, byte[] body) {
        ExecutionNodeEntity node = nodes.findById(nodeId)
                .orElseThrow(() -> new IllegalArgumentException("Unknown execution node"));
        if (node.getStatus() == ExecutionNodeStatus.REVOKED || node.getStatus() == ExecutionNodeStatus.DISABLED) {
            throw new IllegalStateException("Execution node is not authorized");
        }
        Instant requestTime;
        try {
            requestTime = Instant.ofEpochMilli(Long.parseLong(timestamp));
        } catch (Exception error) {
            throw new IllegalArgumentException("Invalid node request timestamp");
        }
        if (Duration.between(requestTime, Instant.now()).abs().compareTo(MAX_CLOCK_SKEW) > 0) {
            throw new IllegalArgumentException("Node request timestamp is outside the allowed clock skew");
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(body == null ? new byte[0] : body);
            String canonical = timestamp + "\n" + method.toUpperCase() + "\n" + path + "\n" + HexFormat.of().formatHex(digest);
            PublicKey key = KeyFactory.getInstance("Ed25519").generatePublic(
                    new X509EncodedKeySpec(Base64.getDecoder().decode(node.getPublicKeyBase64())));
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(key);
            verifier.update(canonical.getBytes(StandardCharsets.UTF_8));
            byte[] supplied = Base64.getDecoder().decode(signatureBase64);
            if (!verifier.verify(supplied)) throw new IllegalArgumentException("Invalid node request signature");
            return node;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("Unable to verify node request signature", error);
        }
    }

    public static String fingerprint(String publicKeyBase64) {
        try {
            byte[] encoded = Base64.getDecoder().decode(publicKeyBase64);
            return "SHA256:" + Base64.getUrlEncoder().withoutPadding().encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(encoded));
        } catch (Exception error) {
            throw new IllegalArgumentException("Invalid Ed25519 public key", error);
        }
    }
}
