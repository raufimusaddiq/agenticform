package com.agenticform.policy;

import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class PolicyPreauthorizationService {
    private static final Duration GRANT_TTL = Duration.ofMinutes(5);
    private final Map<UUID, Grant> grants = new ConcurrentHashMap<>();

    public UUID issue(UUID agentId, UUID taskId, String action, String environment) {
        cleanup();
        UUID id = UUID.randomUUID();
        grants.put(id, new Grant(id, agentId, taskId, action, environment, Instant.now().plus(GRANT_TTL)));
        return id;
    }

    public UUID consume(UUID agentId, UUID taskId, String action, String environment) {
        cleanup();
        for (Grant grant : grants.values()) {
            if (!grant.matches(agentId, taskId, action, environment)) continue;
            if (grants.remove(grant.id(), grant)) return grant.id();
        }
        return null;
    }

    private void cleanup() {
        Instant now = Instant.now();
        grants.entrySet().removeIf(entry -> !entry.getValue().expiresAt().isAfter(now));
    }

    private record Grant(UUID id, UUID agentId, UUID taskId, String action, String environment, Instant expiresAt) {
        private boolean matches(UUID candidateAgentId, UUID candidateTaskId, String candidateAction, String candidateEnvironment) {
            return java.util.Objects.equals(agentId, candidateAgentId)
                    && java.util.Objects.equals(taskId, candidateTaskId)
                    && action.equals(candidateAction)
                    && environment.equals(candidateEnvironment);
        }
    }
}
