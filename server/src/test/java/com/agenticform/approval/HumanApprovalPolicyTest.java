package com.agenticform.approval;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentQueueMode;
import com.agenticform.agent.HumanControlMode;
import com.agenticform.policy.DeterministicPolicyEngine;
import com.agenticform.policy.PolicyActionClassifier;
import com.agenticform.policy.PolicyContext;
import com.agenticform.policy.PolicyDecision;
import com.agenticform.policy.PolicyEffect;
import com.agenticform.policy.PolicyScopeType;
import com.agenticform.workspace.WorkspaceMode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class HumanApprovalPolicyTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final DeterministicPolicyEngine engine = mock(DeterministicPolicyEngine.class);
    private final PolicyActionClassifier classifier = new PolicyActionClassifier();
    private final HumanApprovalPolicy policy = new HumanApprovalPolicy(classifier, engine);

    @BeforeEach
    void defaultRules() {
        when(engine.evaluate(any())).thenAnswer(invocation -> {
            PolicyContext context = invocation.getArgument(0);
            PolicyEffect effect = switch (context.action()) {
                case "PRODUCTION_DEPLOY", "PRODUCTION_DML", "DELETE_DATA", "USER_INPUT" -> PolicyEffect.REQUIRE_HUMAN;
                default -> PolicyEffect.ALLOW;
            };
            return new PolicyDecision(effect, UUID.randomUUID(), PolicyScopeType.GLOBAL, null,
                    context.action(), context.environment(), "test rule");
        });
    }

    @Test
    void strictHitlTightensConfiguredAllow() {
        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.IN_THE_LOOP), HumanApprovalType.COMMAND_EXECUTION, command("mvn test"));

        assertThat(result.effect()).isEqualTo(PolicyEffect.REQUIRE_HUMAN);
        assertThat(result.autoApprove()).isFalse();
        assertThat(result.action()).isEqualTo("COMMAND_EXECUTION");
    }

    @Test
    void hotlUsesConfiguredAllowForNormalDevelopmentCommands() {
        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.ON_THE_LOOP), HumanApprovalType.COMMAND_EXECUTION,
                command("docker compose up -d postgres"));

        assertThat(result.effect()).isEqualTo(PolicyEffect.ALLOW);
        assertThat(result.autoApprove()).isTrue();
    }

    @Test
    void ordinaryPermissionExpansionUsesPolicyInsteadOfHardcodedEscalation() {
        ObjectNode params = mapper.createObjectNode();
        params.put("reason", "Install a dependency from Maven Central");
        params.putObject("permissions").putObject("network").put("enabled", true);

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.ON_THE_LOOP), HumanApprovalType.PERMISSIONS, params);

        assertThat(result.action()).isEqualTo("PERMISSIONS");
        assertThat(result.effect()).isEqualTo(PolicyEffect.ALLOW);
    }

    @Test
    void classifierMapsProductionDeployToConfiguredAction() {
        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.ON_THE_LOOP), HumanApprovalType.COMMAND_EXECUTION,
                command("kubectl apply -f k8s/ --namespace production"));

        assertThat(result.action()).isEqualTo("PRODUCTION_DEPLOY");
        assertThat(result.environment()).isEqualTo("production");
        assertThat(result.effect()).isEqualTo(PolicyEffect.REQUIRE_HUMAN);
    }

    @Test
    void classifierMapsProductionDmlToConfiguredAction() {
        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.ON_THE_LOOP), HumanApprovalType.COMMAND_EXECUTION,
                command("psql $PRODUCTION_DATABASE_URL -c \"update users set active=true where id=42\""));

        assertThat(result.action()).isEqualTo("PRODUCTION_DML");
        assertThat(result.effect()).isEqualTo(PolicyEffect.REQUIRE_HUMAN);
    }

    @Test
    void classifierMapsDeleteDataIndependentOfEnvironment() {
        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.ON_THE_LOOP), HumanApprovalType.COMMAND_EXECUTION,
                command("psql devdb -c \"delete from transactions where id=7\""));

        assertThat(result.action()).isEqualTo("DELETE_DATA");
        assertThat(result.effect()).isEqualTo(PolicyEffect.REQUIRE_HUMAN);
    }

    @Test
    void hotlAutoApprovesOrdinaryFileChangesWhenRuleAllows() {
        ObjectNode params = mapper.createObjectNode();
        params.put("grantRoot", "/tmp/generated-client");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.ON_THE_LOOP), HumanApprovalType.FILE_CHANGE, params);

        assertThat(result.effect()).isEqualTo(PolicyEffect.ALLOW);
        assertThat(result.autoApprove()).isTrue();
    }

    @Test
    void userInputIsPolicyGovernedAndHumanGatedByDefaultRule() {
        ObjectNode params = mapper.createObjectNode();
        params.putArray("questions").addObject()
                .put("id", "q1")
                .put("question", "Which production tenant should this target?");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.ON_THE_LOOP), HumanApprovalType.USER_INPUT, params);

        assertThat(result.action()).isEqualTo("USER_INPUT");
        assertThat(result.effect()).isEqualTo(PolicyEffect.REQUIRE_HUMAN);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void denyCannotBeWeakenedByHitlOrHotlMode() {
        doReturn(new PolicyDecision(
                PolicyEffect.DENY, UUID.randomUUID(), PolicyScopeType.PROJECT, UUID.randomUUID(),
                "COMMAND_EXECUTION", "*", "blocked by project policy"))
                .when(engine).evaluate(any());

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent(HumanControlMode.IN_THE_LOOP), HumanApprovalType.COMMAND_EXECUTION, command("mvn test"));

        assertThat(result.effect()).isEqualTo(PolicyEffect.DENY);
        assertThat(result.autoApprove()).isFalse();
    }

    private ObjectNode command(String command) {
        ObjectNode params = mapper.createObjectNode();
        params.put("cwd", "/srv/worktrees/richmod/backend");
        params.put("command", command);
        return params;
    }

    private AgentEntity agent(HumanControlMode mode) {
        return new AgentEntity(
                UUID.randomUUID(),
                "Backend",
                "Own backend implementation",
                "thread-test",
                WorkspaceMode.ISOLATED_WORKTREE,
                "/srv/apps/richmod",
                "/srv/worktrees/richmod/backend",
                "agent/backend",
                AgentQueueMode.AUTO,
                mode
        );
    }
}
