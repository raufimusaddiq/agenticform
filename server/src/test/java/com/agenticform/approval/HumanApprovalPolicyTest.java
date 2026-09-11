package com.agenticform.approval;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentQueueMode;
import com.agenticform.agent.HumanControlMode;
import com.agenticform.workspace.WorkspaceMode;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class HumanApprovalPolicyTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final HumanApprovalPolicy policy = new HumanApprovalPolicy();

    @Test
    void strictHitlStillBlocksNormalWorkWhenExplicitlySelected() {
        AgentEntity agent = agent(HumanControlMode.IN_THE_LOOP);
        ObjectNode params = command("mvn test");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION, params);

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.LOW);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void hotlAutoApprovesNormalAndUnknownDevelopmentCommands() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION,
                command("docker compose up -d postgres"));

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.LOW);
        assertThat(result.autoApprove()).isTrue();
    }

    @Test
    void hotlAutoApprovesOrdinaryPermissionExpansionUntilAgentIsActuallyBlocked() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.put("cwd", "/srv/worktrees/richmod/backend");
        params.put("reason", "Install a dependency from Maven Central");
        params.putObject("permissions").putObject("network").put("enabled", true);

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.PERMISSIONS, params);

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.LOW);
        assertThat(result.autoApprove()).isTrue();
    }

    @Test
    void productionDeployIsAlwaysHumanGated() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = command("kubectl apply -f k8s/ --namespace production");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION, params);

        assertThat(policy.protectedCommand(params)).isEqualTo(ProtectedActionKind.PRODUCTION_DEPLOY);
        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.HIGH);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void productionDmlIsAlwaysHumanGated() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = command("psql $PRODUCTION_DATABASE_URL -c \"update users set active=true where id=42\"");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION, params);

        assertThat(policy.protectedCommand(params)).isEqualTo(ProtectedActionKind.PRODUCTION_DML);
        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.HIGH);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void deletingPersistentDataIsAlwaysHumanGatedEvenOutsideProduction() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = command("psql devdb -c \"delete from transactions where id=7\"");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION, params);

        assertThat(policy.protectedCommand(params)).isEqualTo(ProtectedActionKind.DELETE_DATA);
        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.HIGH);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void hotlAutoApprovesOrdinaryFileChanges() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.put("grantRoot", "/tmp/generated-client");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.FILE_CHANGE, params);

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.LOW);
        assertThat(result.autoApprove()).isTrue();
    }

    @Test
    void hotlNeverAutoAnswersWhenAgentNeedsHumanInput() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.putArray("questions").addObject()
                .put("id", "q1")
                .put("question", "Which production tenant should this target?");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.USER_INPUT, params);

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
