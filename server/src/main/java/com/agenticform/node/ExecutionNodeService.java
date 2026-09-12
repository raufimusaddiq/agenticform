package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.config.AgenticformProperties;
import com.agenticform.runtime.RuntimeType;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.UUID;

@Service
public class ExecutionNodeService {
    public record Enrollment(String token, Instant expiresAt, String setupCommand) {}
    public record EnrollmentResult(UUID nodeId, String name, String fingerprint, NodeTrustLevel trustLevel) {}
    public record RuntimeObservation(UUID agentId, RuntimeType runtimeType, long runtimeGeneration, String threadId,
                                     String sourceDirectory, String workingDirectory, String branch,
                                     String runtimeStatus) {}
    public record Heartbeat(int protocolVersion, String labelsJson, String capabilitiesJson, int maxAgents,
                            String os, String arch, String hostname, String nodeVersion,
                            String codexVersion, Integer cpuCores, Long memoryMb, Long diskFreeMb,
                            List<RuntimeObservation> runtimes) {}
    public record CommandCompletion(NodeCommandEntity command, boolean newlyCompleted) {}

    private final ExecutionNodeRepository nodes;
    private final NodeEnrollmentTokenRepository tokens;
    private final NodeCommandRepository commands;
    private final AgentRepository agents;
    private final NodeRuntimeSnapshotRepository runtimeSnapshots;
    private final AgenticformProperties properties;
    private final ObjectMapper mapper;
    private final SecureRandom random = new SecureRandom();

    public ExecutionNodeService(ExecutionNodeRepository nodes,
                                NodeEnrollmentTokenRepository tokens,
                                NodeCommandRepository commands,
                                AgentRepository agents,
                                NodeRuntimeSnapshotRepository runtimeSnapshots,
                                AgenticformProperties properties,
                                ObjectMapper mapper) {
        this.nodes = nodes;
        this.tokens = tokens;
        this.commands = commands;
        this.agents = agents;
        this.runtimeSnapshots = runtimeSnapshots;
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
        String command = "test \"$(id -u)\" -ne 0 || { echo 'Run Agenticform node setup as a non-root user'; exit 1; }; "
                + "test -d \"$HOME/.codex\" || { echo 'Codex login is required on this node first'; exit 1; }; "
                + "mkdir -p \"$HOME/.agenticform-node\" && chmod 700 \"$HOME/.agenticform-node\" && "
                + "docker run --rm --user \"$(id -u):$(id -g)\" "
                + "--security-opt no-new-privileges:true --cap-drop ALL "
                + "-v \"$HOME/.agenticform-node:/var/lib/agenticform-node\" "
                + "-e AGENTICFORM_SERVER='" + server + "' "
                + "-e AGENTICFORM_ENROLLMENT_TOKEN='" + token + "' " + image + " enroll"
                + " && docker run -d --name " + containerName + " --restart unless-stopped "
                + "--user \"$(id -u):$(id -g)\" --security-opt no-new-privileges:true --cap-drop ALL "
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
        node.heartbeat(heartbeat.protocolVersion(), heartbeat.labelsJson(), heartbeat.capabilitiesJson(), heartbeat.maxAgents(),
                heartbeat.os(), heartbeat.arch(), heartbeat.hostname(), heartbeat.nodeVersion(),
                heartbeat.codexVersion(), heartbeat.cpuCores(), heartbeat.memoryMb(), heartbeat.diskFreeMb());
        ExecutionNodeEntity saved = nodes.save(node);
        reconcileRuntimeInventory(nodeId, heartbeat.runtimes());
        return saved;
    }

    private void reconcileRuntimeInventory(UUID nodeId, List<RuntimeObservation> observations) {
        if (observations == null) return;
        for (RuntimeObservation observation : observations) {
            if (observation == null || observation.agentId() == null) continue;
            AgentEntity agent = agents.findById(observation.agentId()).orElse(null);
            if (agent == null) continue;

            NodeRuntimeSnapshotEntity snapshot = runtimeSnapshots
                    .findByNodeIdAndAgentId(nodeId, observation.agentId())
                    .orElseGet(() -> new NodeRuntimeSnapshotEntity(nodeId, observation.agentId()));
            String status = agent.ownsRuntime(nodeId, observation.runtimeGeneration()) ? observation.runtimeStatus() : "STALE";
            snapshot.observe(observation.runtimeType(), observation.runtimeGeneration(), observation.threadId(), observation.sourceDirectory(),
                    observation.workingDirectory(), observation.branch(), status);
            runtimeSnapshots.save(snapshot);

            if (!agent.ownsRuntime(nodeId, observation.runtimeGeneration())) continue;
            if (agent.getCodexThreadId() != null && observation.threadId() != null
                    && !agent.getCodexThreadId().equals(observation.threadId())) {
                continue;
            }
            agent.recoverFromSnapshot(observation.runtimeGeneration(), observation.threadId(),
                    observation.sourceDirectory(), observation.workingDirectory(), observation.branch());
            agents.save(agent);
        }
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
        if (!node.isProtocolCompatible()) {
            throw new IllegalStateException("Execution node protocol " + node.getProtocolVersion()
                    + " is incompatible with this control plane");
        }
        long generation = 0;
        if (agentId != null) {
            AgentEntity agent = agents.findById(agentId)
                    .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
            if (!nodeId.equals(agent.getExecutionNodeId())) {
                throw new IllegalStateException("Agent runtime is assigned to a different execution node");
            }
            generation = agent.getRuntimeGeneration();
        }
        final long runtimeGeneration = generation;
        return commands.findByIdempotencyKey(idempotencyKey).orElseGet(() -> {
            try {
                Map<String, Object> commandPayload = new LinkedHashMap<>();
                if (payload != null) commandPayload.putAll(payload);
                commandPayload.put("runtimeGeneration", runtimeGeneration);
                return commands.save(new NodeCommandEntity(nodeId, agentId, runtimeGeneration, type, idempotencyKey,
                        mapper.writeValueAsString(commandPayload)));
            } catch (Exception error) {
                throw new IllegalStateException("Unable to serialize node command", error);
            }
        });
    }

    @Transactional
    public NodeCommandEntity leaseNext(UUID nodeId) {
        ExecutionNodeEntity node = get(nodeId);
        if (!node.isProtocolCompatible()) return null;
        Instant now = Instant.now();
        for (int stale = 0; stale < 100; stale++) {
            NodeCommandEntity command = commands.findNextAvailableForUpdate(nodeId, now).orElse(null);
            if (command == null) return null;
            if (!commandRuntimeCurrent(command)) {
                command.cancel("Runtime generation is stale; current agent runtime has moved");
                commands.save(command);
                continue;
            }
            command.lease(now.plus(properties.getNode().getCommandLease()));
            return commands.save(command);
        }
        throw new IllegalStateException("Too many stale node commands require reconciliation");
    }

    private boolean commandRuntimeCurrent(NodeCommandEntity command) {
        if (command.getAgentId() == null) return true;
        AgentEntity agent = agents.findById(command.getAgentId()).orElse(null);
        return agent != null && agent.ownsRuntime(command.getNodeId(), command.getRuntimeGeneration());
    }

    @Transactional
    public CommandCompletion complete(UUID nodeId, UUID commandId, boolean success,
                                      String resultJson, String error) {
        NodeCommandEntity command = commands.findByIdForUpdate(commandId)
                .orElseThrow(() -> new NoSuchElementException("Node command not found: " + commandId));
        if (!nodeId.equals(command.getNodeId())) throw new IllegalArgumentException("Node command belongs to another node");

        String normalizedResult = resultJson == null ? "{}" : resultJson;
        String normalizedError = error == null || error.isBlank() ? "Node command failed" : error;
        if (command.getStatus() == NodeCommandEntity.Status.SUCCEEDED) {
            if (!success || !Objects.equals(command.getResultJson(), normalizedResult)) {
                throw new IllegalStateException("Conflicting duplicate completion for successful node command");
            }
            return new CommandCompletion(command, false);
        }
        if (command.getStatus() == NodeCommandEntity.Status.FAILED) {
            if (success || !Objects.equals(command.getLastError(), normalizedError)) {
                throw new IllegalStateException("Conflicting duplicate completion for failed node command");
            }
            return new CommandCompletion(command, false);
        }
        if (command.getStatus() == NodeCommandEntity.Status.CANCELLED) {
            throw new IllegalStateException("Node command was cancelled as stale");
        }
        if (!commandRuntimeCurrent(command)) {
            command.cancel("Stale runtime completion was fenced");
            commands.save(command);
            throw new IllegalStateException("Node command runtime generation is stale");
        }
        if (command.getStatus() != NodeCommandEntity.Status.LEASED) {
            throw new IllegalStateException("Node command is not currently leased");
        }
        if (success) command.succeed(normalizedResult);
        else command.fail(normalizedError);
        return new CommandCompletion(commands.save(command), true);
    }

    public List<NodeRuntimeSnapshotEntity> runtimes(UUID nodeId) {
        get(nodeId);
        return runtimeSnapshots.findAllByNodeId(nodeId);
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
