package com.agenticform.policy;

import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class PolicyPreauthorizationServiceTest {
    private final PolicyPreauthorizationService service = new PolicyPreauthorizationService();

    @Test
    void grantCanOnlyBeConsumedOnce() {
        UUID agent = UUID.randomUUID();
        UUID task = UUID.randomUUID();
        UUID grant = service.issue(agent, task, "PRODUCTION_DEPLOY", "production");

        assertThat(service.consume(agent, task, "PRODUCTION_DEPLOY", "production")).isEqualTo(grant);
        assertThat(service.consume(agent, task, "PRODUCTION_DEPLOY", "production")).isNull();
    }

    @Test
    void grantIsScopedToAgentTaskActionAndEnvironment() {
        UUID agent = UUID.randomUUID();
        UUID task = UUID.randomUUID();
        service.issue(agent, task, "PRODUCTION_DML", "production");

        assertThat(service.consume(UUID.randomUUID(), task, "PRODUCTION_DML", "production")).isNull();
        assertThat(service.consume(agent, UUID.randomUUID(), "PRODUCTION_DML", "production")).isNull();
        assertThat(service.consume(agent, task, "DELETE_DATA", "production")).isNull();
        assertThat(service.consume(agent, task, "PRODUCTION_DML", "staging")).isNull();
        assertThat(service.consume(agent, task, "PRODUCTION_DML", "production")).isNotNull();
    }

    @Test
    void wildcardEnvironmentSupportsOlderProtectedToolThreadsButRemainsOneShot() {
        UUID agent = UUID.randomUUID();
        UUID task = UUID.randomUUID();
        UUID grant = service.issue(agent, task, "DELETE_DATA", "*");

        assertThat(service.consume(agent, task, "DELETE_DATA", "production")).isEqualTo(grant);
        assertThat(service.consume(agent, task, "DELETE_DATA", "development")).isNull();
    }
}
