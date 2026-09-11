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
    void hitlNeverAutoApprovesEvenSafeCommand() {
        AgentEntity agent = agent(HumanControlMode.IN_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.put("cwd", "/srv/worktrees/richmod/backend");
        params.put("command", "mvn test");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION, params);

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.LOW);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void hotlAutoApprovesSafeCommandInsideWorkspace() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.put("cwd", "/srv/worktrees/richmod/backend");
        params.put("command", "mvn test");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION, params);

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.LOW);
        assertThat(result.autoApprove()).isTrue();
    }

    @Test
    void hotlEscalatesUnknownOrChainedCommand() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.put("cwd", "/srv/worktrees/richmod/backend");
        params.put("command", "mvn test && rm -rf target");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION, params);

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.ELEVATED);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void hotlEscalatesNetworkOrPolicyChanges() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.put("cwd", "/srv/worktrees/richmod/backend");
        params.put("command", "mvn test");
        params.putObject("networkApprovalContext").put("host", "example.com");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.COMMAND_EXECUTION, params);

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.HIGH);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void hotlEscalatesWriteRootOutsideWorkspace() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.put("grantRoot", "/etc");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.FILE_CHANGE, params);

        assertThat(result.risk()).isEqualTo(HumanApprovalRisk.HIGH);
        assertThat(result.autoApprove()).isFalse();
    }

    @Test
    void hotlNeverAutoAnswersUserInput() {
        AgentEntity agent = agent(HumanControlMode.ON_THE_LOOP);
        ObjectNode params = mapper.createObjectNode();
        params.putArray("questions").addObject()
                .put("id", "q1")
                .put("question", "Which migration strategy should I use?");

        HumanApprovalPolicy.Evaluation result = policy.evaluate(
                agent, HumanApprovalType.USER_INPUT, params);

        assertThat(result.autoApprove()).isFalse();
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
