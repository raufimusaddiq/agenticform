package com.agenticform.node;

import com.agenticform.config.AgenticformProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class NodeSignatureVerifierTest {
    @Mock ExecutionNodeRepository nodes;
    @Mock NodeRequestNonceRepository nonces;

    private AgenticformProperties properties;
    private NodeSignatureVerifier verifier;
    private UUID nodeId;
    private KeyPair keyPair;
    private ExecutionNodeEntity node;

    @BeforeEach
    void setUp() throws Exception {
        properties = new AgenticformProperties();
        properties.getNode().setMaxClockSkew(Duration.ofMinutes(2));
        properties.getNode().setRequestNonceTtl(Duration.ofMinutes(10));
        verifier = new NodeSignatureVerifier(nodes, nonces, properties);
        nodeId = UUID.randomUUID();
        keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String publicKey = Base64.getEncoder().encodeToString(keyPair.getPublic().getEncoded());
        node = new ExecutionNodeEntity("test-node", NodeTrustLevel.STANDARD, publicKey,
                NodeSignatureVerifier.fingerprint(publicKey));
        when(nodes.findById(nodeId)).thenReturn(Optional.of(node));
    }

    @Test
    void acceptsValidSignatureAndConsumesNonce() throws Exception {
        byte[] body = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
        String timestamp = Long.toString(Instant.now().toEpochMilli());
        String nonce = "nonce-0123456789abcdef";
        String signature = sign(timestamp, nonce, "POST", "/api/nodes/" + nodeId + "/heartbeat", body);
        when(nonces.insertIfAbsent(any(), eq(nodeId), eq(nonce), any(), any())).thenReturn(1);

        verifier.verify(nodeId, timestamp, nonce, signature, "POST",
                "/api/nodes/" + nodeId + "/heartbeat", body);

        verify(nonces).insertIfAbsent(any(), eq(nodeId), eq(nonce), any(), any());
    }

    @Test
    void rejectsReplayAfterValidSignature() throws Exception {
        byte[] body = new byte[0];
        String timestamp = Long.toString(Instant.now().toEpochMilli());
        String nonce = "nonce-0123456789abcdef";
        String path = "/api/nodes/" + nodeId + "/commands/next";
        String signature = sign(timestamp, nonce, "GET", path, body);
        when(nonces.insertIfAbsent(any(), eq(nodeId), eq(nonce), any(), any())).thenReturn(0);

        assertThrows(NodeAuthenticationException.class,
                () -> verifier.verify(nodeId, timestamp, nonce, signature, "GET", path, body));
    }

    @Test
    void rejectsInvalidSignatureBeforeNonceConsumption() {
        String timestamp = Long.toString(Instant.now().toEpochMilli());
        assertThrows(NodeAuthenticationException.class,
                () -> verifier.verify(nodeId, timestamp, "nonce-0123456789abcdef",
                        Base64.getEncoder().encodeToString(new byte[64]), "GET",
                        "/api/nodes/" + nodeId + "/commands/next", new byte[0]));
        verifyNoInteractions(nonces);
    }

    @Test
    void rejectsRevokedNodeBeforeNonceConsumption() throws Exception {
        node.setStatus(ExecutionNodeStatus.REVOKED);
        String timestamp = Long.toString(Instant.now().toEpochMilli());
        String nonce = "nonce-0123456789abcdef";
        String path = "/api/nodes/" + nodeId + "/commands/next";
        String signature = sign(timestamp, nonce, "GET", path, new byte[0]);

        assertThrows(NodeAuthenticationException.class,
                () -> verifier.verify(nodeId, timestamp, nonce, signature, "GET", path, new byte[0]));
        verifyNoInteractions(nonces);
    }

    @Test
    void rejectsNonEd25519EnrollmentKey() throws Exception {
        KeyPair rsa = KeyPairGenerator.getInstance("RSA").generateKeyPair();
        String encoded = Base64.getEncoder().encodeToString(rsa.getPublic().getEncoded());
        assertThrows(IllegalArgumentException.class, () -> NodeSignatureVerifier.fingerprint(encoded));
    }

    @Test
    void rejectsExpiredTimestampBeforeNonceConsumption() throws Exception {
        byte[] body = new byte[0];
        String timestamp = Long.toString(Instant.now().minus(Duration.ofMinutes(10)).toEpochMilli());
        String nonce = "nonce-0123456789abcdef";
        String path = "/api/nodes/" + nodeId + "/commands/next";
        String signature = sign(timestamp, nonce, "GET", path, body);

        assertThrows(NodeAuthenticationException.class,
                () -> verifier.verify(nodeId, timestamp, nonce, signature, "GET", path, body));
        verifyNoInteractions(nonces);
    }

    private String sign(String timestamp, String nonce, String method, String path, byte[] body) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(body);
        String canonical = nodeId + "\n" + timestamp + "\n" + nonce + "\n" + method + "\n" + path + "\n"
                + HexFormat.of().formatHex(digest);
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(keyPair.getPrivate());
        signer.update(canonical.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(signer.sign());
    }
}
