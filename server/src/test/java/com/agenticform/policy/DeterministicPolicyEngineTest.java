package com.agenticform.policy;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class DeterministicPolicyEngineTest {
    private final PolicyRuleRepository repository = mock(PolicyRuleRepository.class);
    private final DeterministicPolicyEngine engine = new DeterministicPolicyEngine(repository);

    @Test
    void agentScopedWildcardCannotEraseGlobalProductionDeployGate() {
        UUID project = UUID.randomUUID();
        UUID agent = UUID.randomUUID();
        PolicyRuleEntity productionGate = rule(PolicyScopeType.GLOBAL, null, "PRODUCTION_DEPLOY", "production", PolicyEffect.REQUIRE_HUMAN);
        PolicyRuleEntity evasion = rule(PolicyScopeType.AGENT, agent, "*", "*", PolicyEffect.ALLOW);
        PolicyRuleEntity fallback = rule(PolicyScopeType.GLOBAL, null, "*", "*", PolicyEffect.ALLOW);
        when(repository.findAllByEnabledTrue()).thenReturn(List.of(evasion, fallback, productionGate));

        PolicyDecision decision = engine.evaluate(new PolicyContext(project, agent, null, "PRODUCTION_DEPLOY", "production"));

        assertThat(decision.effect()).isEqualTo(PolicyEffect.REQUIRE_HUMAN);
        assertThat(decision.matchedRuleId()).isEqualTo(productionGate.getId());
    }

    @Test
    void agentScopedWildcardCannotEraseDeletionGate() {
        UUID project = UUID.randomUUID();
        UUID agent = UUID.randomUUID();
        PolicyRuleEntity deletionGate = rule(PolicyScopeType.GLOBAL, null, "DELETE_DATA", "*", PolicyEffect.REQUIRE_HUMAN);
        PolicyRuleEntity evasion = rule(PolicyScopeType.PROJECT, project, "*", "*", PolicyEffect.ALLOW);
        PolicyRuleEntity fallback = rule(PolicyScopeType.GLOBAL, null, "*", "*", PolicyEffect.ALLOW);
        when(repository.findAllByEnabledTrue()).thenReturn(List.of(evasion, fallback, deletionGate));

        PolicyDecision decision = engine.evaluate(new PolicyContext(project, agent, null, "DELETE_DATA", "staging"));

        assertThat(decision.effect()).isEqualTo(PolicyEffect.REQUIRE_HUMAN);
        assertThat(decision.matchedRuleId()).isEqualTo(deletionGate.getId());
    }

    @Test
    void taskScopeBeatsAgentProjectAndGlobal() {
        UUID project = UUID.randomUUID();
        UUID agent = UUID.randomUUID();
        UUID task = UUID.randomUUID();
        PolicyRuleEntity global = rule(PolicyScopeType.GLOBAL, null, "PRODUCTION_DEPLOY", "production", PolicyEffect.REQUIRE_HUMAN);
        PolicyRuleEntity projectRule = rule(PolicyScopeType.PROJECT, project, "PRODUCTION_DEPLOY", "production", PolicyEffect.DENY);
        PolicyRuleEntity agentRule = rule(PolicyScopeType.AGENT, agent, "PRODUCTION_DEPLOY", "production", PolicyEffect.REQUIRE_HUMAN);
        PolicyRuleEntity taskRule = rule(PolicyScopeType.TASK, task, "PRODUCTION_DEPLOY", "production", PolicyEffect.ALLOW);
        when(repository.findAllByEnabledTrue()).thenReturn(List.of(global, projectRule, agentRule, taskRule));

        PolicyDecision decision = engine.evaluate(new PolicyContext(project, agent, task, "production deploy", "PRODUCTION"));

        assertThat(decision.effect()).isEqualTo(PolicyEffect.ALLOW);
        assertThat(decision.matchedScopeType()).isEqualTo(PolicyScopeType.TASK);
    }

    @Test
    void exactActionBeatsWildcardWithinSameScope() {
        UUID project = UUID.randomUUID();
        PolicyRuleEntity wildcard = rule(PolicyScopeType.PROJECT, project, "*", "production", PolicyEffect.ALLOW);
        PolicyRuleEntity exact = rule(PolicyScopeType.PROJECT, project, "PRODUCTION_DML", "*", PolicyEffect.REQUIRE_HUMAN);
        PolicyRuleEntity fallback = rule(PolicyScopeType.GLOBAL, null, "*", "*", PolicyEffect.ALLOW);
        when(repository.findAllByEnabledTrue()).thenReturn(List.of(wildcard, exact, fallback));

        PolicyDecision decision = engine.evaluate(new PolicyContext(project, null, null, "PRODUCTION_DML", "production"));

        assertThat(decision.effect()).isEqualTo(PolicyEffect.REQUIRE_HUMAN);
        assertThat(decision.matchedRuleId()).isEqualTo(exact.getId());
    }

    @Test
    void exactEnvironmentBeatsWildcardAfterActionSpecificity() {
        PolicyRuleEntity wildcardEnv = rule(PolicyScopeType.GLOBAL, null, "DELETE_DATA", "*", PolicyEffect.REQUIRE_HUMAN);
        PolicyRuleEntity production = rule(PolicyScopeType.GLOBAL, null, "DELETE_DATA", "production", PolicyEffect.DENY);
        PolicyRuleEntity fallback = rule(PolicyScopeType.GLOBAL, null, "*", "*", PolicyEffect.ALLOW);
        when(repository.findAllByEnabledTrue()).thenReturn(List.of(wildcardEnv, production, fallback));

        PolicyDecision decision = engine.evaluate(new PolicyContext(null, null, null, "DELETE_DATA", "production"));

        assertThat(decision.effect()).isEqualTo(PolicyEffect.DENY);
        assertThat(decision.matchedRuleId()).isEqualTo(production.getId());
    }

    @Test
    void globalWildcardIsDeterministicFallback() {
        PolicyRuleEntity fallback = rule(PolicyScopeType.GLOBAL, null, "*", "*", PolicyEffect.ALLOW);
        when(repository.findAllByEnabledTrue()).thenReturn(List.of(fallback));

        PolicyDecision decision = engine.evaluate(new PolicyContext(null, null, null, "SOMETHING_NEW", "staging"));

        assertThat(decision.effect()).isEqualTo(PolicyEffect.ALLOW);
        assertThat(decision.matchedRuleId()).isEqualTo(fallback.getId());
    }

    @Test
    void missingFallbackFailsClosed() {
        when(repository.findAllByEnabledTrue()).thenReturn(List.of());

        assertThatThrownBy(() -> engine.evaluate(new PolicyContext(null, null, null, "COMMAND_EXECUTION", "*")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("global wildcard rule is required");
    }

    private PolicyRuleEntity rule(PolicyScopeType scopeType, UUID scopeId, String action,
                                  String environment, PolicyEffect effect) {
        PolicyRuleEntity rule = mock(PolicyRuleEntity.class);
        when(rule.getId()).thenReturn(UUID.randomUUID());
        when(rule.getScopeType()).thenReturn(scopeType);
        when(rule.getScopeId()).thenReturn(scopeId);
        when(rule.getAction()).thenReturn(action);
        when(rule.getEnvironment()).thenReturn(environment);
        when(rule.getEffect()).thenReturn(effect);
        when(rule.getDescription()).thenReturn("test");
        return rule;
    }
}
