package com.agenticform.policy;

import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class PolicyPreauthorizationService {
    private static final Duration GRANT_TTL = Duration.ofMinutes(5);
    private final Map<UUID, Grant> grants = new ConcurrentHashMap<>();

    public UUID issue(UUID agentId, UUID taskId, String action, String environment, String effectDigest) {
        if (agentId == null || action == null || action.isBlank()) {
            throw new IllegalArgumentException("agentId and action are required for preauthorization");
        }
        if (effectDigest == null || effectDigest.isBlank()) {
            throw new IllegalArgumentException("effectDigest is required for preauthorization");
        }
        cleanup();
        UUID id = UUID.randomUUID();
        String normalizedEnvironment = environment == null || environment.isBlank() ? "*" : environment;
        grants.put(id, new Grant(id, agentId, taskId, action, normalizedEnvironment,
                effectDigest, Instant.now().plus(GRANT_TTL)));
        return id;
    }

    public UUID consume(UUID agentId, UUID taskId, String action, String environment, String effectDigest) {
        if (effectDigest == null || effectDigest.isBlank()) return null;
        cleanup();
        String normalizedEnvironment = environment == null || environment.isBlank() ? "*" : environment;
        for (Grant grant : grants.values()) {
            if (!grant.matches(agentId, taskId, action, normalizedEnvironment, effectDigest)) continue;
            if (grants.remove(grant.id(), grant)) return grant.id();
        }
        return null;
    }

    private void cleanup() {
        Instant now = Instant.now();
        grants.entrySet().removeIf(entry -> !entry.getValue().expiresAt().isAfter(now));
    }

    private record Grant(UUID id, UUID agentId, UUID taskId, String action, String environment,
                         String effectDigest, Instant expiresAt) {
        private boolean matches(UUID candidateAgentId, UUID candidateTaskId, String candidateAction,
                                String candidateEnvironment, String candidateEffectDigest) {
            return Objects.equals(agentId, candidateAgentId)
                    && Objects.equals(taskId, candidateTaskId)
                    && action.equals(candidateAction)
                    && (environment.equals(candidateEnvironment) || "*".equals(environment))
                    && effectDigest.equals(candidateEffectDigest);
        }
    }
}
