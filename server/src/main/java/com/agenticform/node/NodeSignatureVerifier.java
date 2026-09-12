package com.agenticform.node;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

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
    private final ExecutionNodeRepository nodes;
    private final NodeRequestNonceRepository nonces;
    private final AgenticformProperties properties;

    public NodeSignatureVerifier(ExecutionNodeRepository nodes,
                                 NodeRequestNonceRepository nonces,
                                 AgenticformProperties properties) {
        this.nodes = nodes;
        this.nonces = nonces;
        this.properties = properties;
    }

    @Transactional
    public ExecutionNodeEntity verify(UUID nodeId, String timestamp, String nonce, String signatureBase64,
                                      String method, String path, byte[] body) {
        ExecutionNodeEntity node = nodes.findById(nodeId)
                .orElseThrow(() -> new NodeAuthenticationException("Unknown execution node"));
        if (node.getStatus() == ExecutionNodeStatus.REVOKED || node.getStatus() == ExecutionNodeStatus.DISABLED) {
            throw new NodeAuthenticationException("Execution node is not authorized");
        }
        if (nonce == null || !nonce.matches("[A-Za-z0-9._:-]{16,128}")) {
            throw new NodeAuthenticationException("Invalid node request nonce");
        }

        Instant requestTime;
        try {
            requestTime = Instant.ofEpochMilli(Long.parseLong(timestamp));
        } catch (Exception error) {
            throw new NodeAuthenticationException("Invalid node request timestamp");
        }
        Duration maxClockSkew = properties.getNode().getMaxClockSkew();
        if (Duration.between(requestTime, Instant.now()).abs().compareTo(maxClockSkew) > 0) {
            throw new NodeAuthenticationException("Node request timestamp is outside the allowed clock skew");
        }

        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(body == null ? new byte[0] : body);
            String canonical = nodeId + "\n" + timestamp + "\n" + nonce + "\n"
                    + method.toUpperCase() + "\n" + path + "\n" + HexFormat.of().formatHex(digest);
            PublicKey key = decodeEd25519PublicKey(node.getPublicKeyBase64());
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(key);
            verifier.update(canonical.getBytes(StandardCharsets.UTF_8));
            byte[] supplied = Base64.getDecoder().decode(signatureBase64);
            if (!verifier.verify(supplied)) throw new NodeAuthenticationException("Invalid node request signature");
        } catch (NodeAuthenticationException error) {
            throw error;
        } catch (IllegalArgumentException error) {
            throw new NodeAuthenticationException("Invalid node request signature encoding");
        } catch (Exception error) {
            throw new IllegalStateException("Unable to verify node request signature", error);
        }

        Instant now = Instant.now();
        int inserted = nonces.insertIfAbsent(UUID.randomUUID(), nodeId, nonce,
                now.plus(properties.getNode().getRequestNonceTtl()), now);
        if (inserted != 1) {
            throw new NodeAuthenticationException("Replayed node request nonce");
        }
        return node;
    }

    public static String fingerprint(String publicKeyBase64) {
        try {
            PublicKey key = decodeEd25519PublicKey(publicKeyBase64);
            return "SHA256:" + Base64.getUrlEncoder().withoutPadding().encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(key.getEncoded()));
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Invalid Ed25519 public key", error);
        }
    }

    private static PublicKey decodeEd25519PublicKey(String publicKeyBase64) {
        try {
            byte[] encoded = Base64.getDecoder().decode(publicKeyBase64);
            PublicKey key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(encoded));
            if (!"EdDSA".equalsIgnoreCase(key.getAlgorithm()) && !"Ed25519".equalsIgnoreCase(key.getAlgorithm())) {
                throw new IllegalArgumentException("Node public key must be Ed25519");
            }
            return key;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Invalid Ed25519 public key", error);
        }
    }
}
