package com.agenticform.policy;

import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class PolicyPreauthorizationServiceTest {
    private static final String DIGEST = "effect-a";
    private final PolicyPreauthorizationService service = new PolicyPreauthorizationService();

    @Test
    void grantCanOnlyBeConsumedOnce() {
        UUID agent = UUID.randomUUID();
        UUID task = UUID.randomUUID();
        UUID grant = service.issue(agent, task, "PRODUCTION_DEPLOY", "production", DIGEST);

        assertThat(service.consume(agent, task, "PRODUCTION_DEPLOY", "production", DIGEST)).isEqualTo(grant);
        assertThat(service.consume(agent, task, "PRODUCTION_DEPLOY", "production", DIGEST)).isNull();
    }

    @Test
    void grantIsScopedToAgentTaskActionEnvironmentAndExactEffect() {
        UUID agent = UUID.randomUUID();
        UUID task = UUID.randomUUID();
        service.issue(agent, task, "PRODUCTION_DML", "production", DIGEST);

        assertThat(service.consume(UUID.randomUUID(), task, "PRODUCTION_DML", "production", DIGEST)).isNull();
        assertThat(service.consume(agent, UUID.randomUUID(), "PRODUCTION_DML", "production", DIGEST)).isNull();
        assertThat(service.consume(agent, task, "DELETE_DATA", "production", DIGEST)).isNull();
        assertThat(service.consume(agent, task, "PRODUCTION_DML", "staging", DIGEST)).isNull();
        assertThat(service.consume(agent, task, "PRODUCTION_DML", "production", "effect-b")).isNull();
        assertThat(service.consume(agent, task, "PRODUCTION_DML", "production", DIGEST)).isNotNull();
    }

    @Test
    void wildcardEnvironmentStillRequiresExactEffectAndRemainsOneShot() {
        UUID agent = UUID.randomUUID();
        UUID task = UUID.randomUUID();
        UUID grant = service.issue(agent, task, "DELETE_DATA", "*", DIGEST);

        assertThat(service.consume(agent, task, "DELETE_DATA", "production", "different")).isNull();
        assertThat(service.consume(agent, task, "DELETE_DATA", "production", DIGEST)).isEqualTo(grant);
        assertThat(service.consume(agent, task, "DELETE_DATA", "development", DIGEST)).isNull();
    }
}
