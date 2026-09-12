package com.agenticform.message;

import com.agenticform.agent.AgentCapabilityPolicy;
import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.approval.HumanApprovalService;
import com.agenticform.codex.CodexJsonRpcClient;
import com.agenticform.runtime.RuntimeType;
import com.agenticform.operation.OperationRunService;
import com.agenticform.operation.OperationalIncidentService;
import com.agenticform.operation.OperationalRegistryService;
import com.agenticform.operation.OperationalSignalService;
import com.agenticform.policy.PolicyRuleService;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AgenticformDynamicToolHandlerSecurityTest {
    @Test
    void unknownNamespaceIsRejectedBeforeAgentResolution() {
        AgentRepository agents = mock(AgentRepository.class);
        AgenticformDynamicToolHandler handler = handler(agents, new AgentCapabilityPolicy());
        ObjectNode params = new ObjectMapper().createObjectNode().put("namespace", "other");

        assertThrows(IllegalArgumentException.class, () -> handler.handle(request(params)));
    }

    @Test
    void generalAgentCannotRequestProtectedOperation() {
        AgentRepository agents = mock(AgentRepository.class);
        AgentEntity source = mock(AgentEntity.class);
        when(agents.findByRuntimeTypeAndRuntimeSessionId(RuntimeType.CODEX, "thread-1")).thenReturn(Optional.of(source));
        when(source.getCapabilityProfile()).thenReturn(com.agenticform.agent.AgentCapabilityProfile.IMPLEMENTER);
        AgenticformDynamicToolHandler handler = handler(agents, new AgentCapabilityPolicy());
        ObjectNode params = new ObjectMapper().createObjectNode()
                .put("namespace", "agenticform").put("threadId", "thread-1").put("tool", "request_operation")
                .set("arguments", new ObjectMapper().createObjectNode());

        assertThrows(IllegalStateException.class, () -> handler.handle(request(params)));
    }

    private AgenticformDynamicToolHandler handler(AgentRepository agents, AgentCapabilityPolicy policy) {
        return new AgenticformDynamicToolHandler(
                mock(CodexJsonRpcClient.class), agents, mock(AgentMessageService.class),
                mock(HumanApprovalService.class), mock(PolicyRuleService.class),
                mock(OperationalRegistryService.class), mock(OperationRunService.class), policy,
                mock(OperationalSignalService.class), mock(OperationalIncidentService.class), new ObjectMapper());
    }

    private CodexJsonRpcClient.ServerRequest request(ObjectNode params) {
        return new CodexJsonRpcClient.ServerRequest(new ObjectMapper().createObjectNode().put("id", 1),
                "item/tool/call", params);
    }
}
