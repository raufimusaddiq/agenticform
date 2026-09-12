package com.agenticform.node;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class ExecutionNodeService {
    public record Enrollment(String token, Instant expiresAt, String setupCommand) {}
    public record EnrollmentResult(UUID nodeId, String name, String fingerprint, NodeTrustLevel trustLevel) {}
    public record Heartbeat(String labelsJson, String capabilitiesJson, int maxAgents,
                            String os, String arch, String hostname, String nodeVersion,
                            String codexVersion, Integer cpuCores, Long memoryMb, Long diskFreeMb) {}

    private final ExecutionNodeRepository nodes;
    private final NodeEnrollmentTokenRepository tokens;
    private final NodeCommandRepository commands;
    private final AgenticformProperties properties;
    private final ObjectMapper mapper;
    private final SecureRandom random = new SecureRandom();

    public ExecutionNodeService(ExecutionNodeRepository nodes,
                                NodeEnrollmentTokenRepository tokens,
                                NodeCommandRepository commands,
                                AgenticformProperties properties,
                                ObjectMapper mapper) {
        this.nodes = nodes;
        this.tokens = tokens;
        this.commands = commands;
        this.properties = properties;
        this.mapper = mapper;
    }

    public List<ExecutionNodeEntity> list() {
        return nodes.findAll().stream().sorted(Comparator.comparing(ExecutionNodeEntity::getName)).toList();
    }

    public ExecutionNodeEntity get(UUID id) {
        return nodes.findById(id).orElseThrow(() -> new NoSuchElementException("Execution node not found: " + id));
    }

    @Transactional
    public Enrollment createEnrollment(String requestedName, NodeTrustLevel trustLevel) {
        String name = normalizeName(requestedName);
        if (nodes.findByName(name).filter(node -> node.getStatus() != ExecutionNodeStatus.REVOKED).isPresent()) {
            throw new IllegalArgumentException("Execution node name already exists: " + name);
        }
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String token = "afenroll_" + Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        Instant expiresAt = Instant.now().plus(properties.getNode().getEnrollmentTtl());
        tokens.save(new NodeEnrollmentTokenEntity(hash(token), name,
                trustLevel == null ? NodeTrustLevel.STANDARD : trustLevel, expiresAt));

        String server = properties.getPublicUrl().toString().replaceAll("/$", "");
        String image = properties.getNode().getImage();
        String containerName = "agenticform-node-" + name.toLowerCase().replaceAll("[^a-z0-9]+", "-");
        String command = "test -d \"$HOME/.codex\" || { echo 'Codex login is required on this node first'; exit 1; }; "
                + "mkdir -p \"$HOME/.agenticform-node\" && chmod 700 \"$HOME/.agenticform-node\" && "
                + "docker run --rm --user \"$(id -u):$(id -g)\" "
                + "-v \"$HOME/.agenticform-node:/var/lib/agenticform-node\" "
                + "-e AGENTICFORM_SERVER='" + server + "' "
                + "-e AGENTICFORM_ENROLLMENT_TOKEN='" + token + "' " + image + " enroll"
                + " && docker run -d --name " + containerName + " --restart unless-stopped "
                + "--user \"$(id -u):$(id -g)\" "
                + "-v \"$HOME/.agenticform-node:/var/lib/agenticform-node\" "
                + "-v \"$HOME/.codex:/codex-home\" -e CODEX_HOME=/codex-home "
                + "-e AGENTICFORM_SERVER='" + server + "' " + image + " daemon";
        return new Enrollment(token, expiresAt, command);
    }

    @Transactional
    public EnrollmentResult enroll(String rawToken, String publicKeyBase64) {
        if (rawToken == null || !rawToken.startsWith("afenroll_")) {
            throw new IllegalArgumentException("Invalid enrollment token");
        }
        NodeEnrollmentTokenEntity token = tokens.findByTokenHashForUpdate(hash(rawToken))
                .orElseThrow(() -> new IllegalArgumentException("Invalid enrollment token"));
        if (!token.usable(Instant.now())) throw new IllegalArgumentException("Enrollment token is expired or already used");

        String fingerprint = NodeSignatureVerifier.fingerprint(publicKeyBase64);
        if (nodes.findByFingerprint(fingerprint).isPresent()) {
            throw new IllegalArgumentException("Node public key is already enrolled");
        }
        if (nodes.findByName(token.getRequestedName()).filter(node -> node.getStatus() != ExecutionNodeStatus.REVOKED).isPresent()) {
            throw new IllegalArgumentException("Execution node name already exists");
        }

        token.consume();
        tokens.save(token);
        ExecutionNodeEntity node = nodes.save(new ExecutionNodeEntity(
                token.getRequestedName(), token.getRequestedTrustLevel(), publicKeyBase64, fingerprint));
        return new EnrollmentResult(node.getId(), node.getName(), node.getFingerprint(), node.getTrustLevel());
    }

    @Transactional
    public ExecutionNodeEntity heartbeat(UUID nodeId, Heartbeat heartbeat) {
        ExecutionNodeEntity node = get(nodeId);
        node.heartbeat(heartbeat.labelsJson(), heartbeat.capabilitiesJson(), heartbeat.maxAgents(),
                heartbeat.os(), heartbeat.arch(), heartbeat.hostname(), heartbeat.nodeVersion,
                heartbeat.codexVersion(), heartbeat.cpuCores(), heartbeat.memoryMb(), heartbeat.diskFreeMb());
        return nodes.save(node);
    }

    @Transactional
    public ExecutionNodeEntity setStatus(UUID nodeId, ExecutionNodeStatus status) {
        ExecutionNodeEntity node = get(nodeId);
        node.setStatus(status);
        return nodes.save(node);
    }

    @Transactional
    public NodeCommandEntity enqueue(UUID nodeId, UUID agentId, String type,
                                     String idempotencyKey, Map<String, ?> payload) {
        ExecutionNodeEntity node = get(nodeId);
        if (node.getStatus() == ExecutionNodeStatus.REVOKED || node.getStatus() == ExecutionNodeStatus.DISABLED) {
            throw new IllegalStateException("Execution node cannot accept commands: " + node.getStatus());
        }
        return commands.findByIdempotencyKey(idempotencyKey).orElseGet(() -> {
            try {
                return commands.save(new NodeCommandEntity(nodeId, agentId, type, idempotencyKey,
                        mapper.writeValueAsString(payload == null ? Map.of() : payload)));
            } catch (Exception error) {
                throw new IllegalStateException("Unable to serialize node command", error);
            }
        });
    }

    @Transactional
    public NodeCommandEntity leaseNext(UUID nodeId) {
        Instant now = Instant.now();
        NodeCommandEntity command = commands.findNextAvailableForUpdate(nodeId, now).orElse(null);
        if (command == null) return null;
        command.lease(now.plus(properties.getNode().getCommandLease()));
        return commands.save(command);
    }

    @Transactional
    public NodeCommandEntity complete(UUID nodeId, UUID commandId, boolean success,
                                      String resultJson, String error) {
        NodeCommandEntity command = commands.findByIdForUpdate(commandId)
                .orElseThrow(() -> new NoSuchElementException("Node command not found: " + commandId));
        if (!nodeId.equals(command.getNodeId())) throw new IllegalArgumentException("Node command belongs to another node");
        if (command.getStatus() == NodeCommandEntity.Status.SUCCEEDED || command.getStatus() == NodeCommandEntity.Status.FAILED) {
            throw new IllegalStateException("Node command is already terminal");
        }
        if (command.getStatus() != NodeCommandEntity.Status.LEASED) {
            throw new IllegalStateException("Node command is not currently leased");
        }
        if (success) command.succeed(resultJson == null ? "{}" : resultJson);
        else command.fail(error == null || error.isBlank() ? "Node command failed" : error);
        return commands.save(command);
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("Unable to hash enrollment token", error);
        }
    }

    private String normalizeName(String value) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Node name is required");
        String name = value.trim();
        if (name.length() > 128 || !name.matches("[A-Za-z0-9._-]+")) {
            throw new IllegalArgumentException("Node name must contain only letters, numbers, dot, underscore, or dash");
        }
        return name;
    }
}
