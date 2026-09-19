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
import com.agenticform.task.TaskDispatchService;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.Optional;
import java.util.List;
import java.util.UUID;

import tools.jackson.databind.JsonNode;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.ArgumentMatchers.any;
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

    @Test
    void nonOperationalAgentCannotSyncRepositoryRunbook() {
        AgentRepository agents = mock(AgentRepository.class);
        AgentEntity source = mock(AgentEntity.class);
        when(agents.findByRuntimeTypeAndRuntimeSessionId(RuntimeType.CODEX, "thread-1")).thenReturn(Optional.of(source));
        when(source.getCapabilityProfile()).thenReturn(com.agenticform.agent.AgentCapabilityProfile.IMPLEMENTER);
        AgenticformDynamicToolHandler handler = handler(agents, new AgentCapabilityPolicy());
        ObjectNode params = new ObjectMapper().createObjectNode()
                .put("namespace", "agenticform").put("threadId", "thread-1").put("tool", "sync_repository_runbook")
                .set("arguments", new ObjectMapper().createObjectNode());

        assertThrows(IllegalStateException.class, () -> handler.handle(request(params)));
    }

    @Test
    void proposeRepositoryRunbookRequiresDeployCapabilityAndAStructuredManifest() {
        AgentRepository agents = mock(AgentRepository.class);
        AgentEntity source = mock(AgentEntity.class);
        com.agenticform.operation.RepositoryRunbookDiscovery discovery =
                mock(com.agenticform.operation.RepositoryRunbookDiscovery.class);
        when(agents.findByRuntimeTypeAndRuntimeSessionId(RuntimeType.CODEX, "thread-1")).thenReturn(Optional.of(source));
        when(source.getId()).thenReturn(UUID.randomUUID());
        when(source.getProjectId()).thenReturn(UUID.randomUUID());
        when(source.getRole()).thenReturn(com.agenticform.agent.AgentRole.OPERATIONAL);
        when(source.getCapabilityProfile()).thenReturn(com.agenticform.agent.AgentCapabilityProfile.OPS);
        when(discovery.propose(any(), any(), any())).thenReturn(new ObjectMapper().createObjectNode().put("pullRequest", "https://github.com/o/r/pull/1"));
        AgenticformDynamicToolHandler handler = new AgenticformDynamicToolHandler(
                mock(CodexJsonRpcClient.class), agents, mock(AgentMessageService.class),
                mock(HumanApprovalService.class), mock(PolicyRuleService.class),
                mock(OperationalRegistryService.class), mock(OperationRunService.class),
                new AgentCapabilityPolicy(), mock(OperationalSignalService.class),
                mock(OperationalIncidentService.class), mock(TaskDispatchService.class), discovery, new ObjectMapper());
        ObjectNode params = new ObjectMapper().createObjectNode()
                .put("namespace", "agenticform").put("threadId", "thread-1").put("tool", "propose_repository_runbook")
                .set("arguments", new ObjectMapper().createObjectNode().set("manifest", new ObjectMapper().createObjectNode().put("version", 1)));

        String responseText = handler.handle(request(params)).toCompletableFuture().join()
                .path("contentItems").get(0).path("text").asText();

        assertEquals("https://github.com/o/r/pull/1", new ObjectMapper().readTree(responseText).path("pullRequest").asText());
    }

    @Test
    void proposeRepositoryRunbookRejectsMissingManifestBeforeTouchingTheRepository() {
        AgentRepository agents = mock(AgentRepository.class);
        AgentEntity source = mock(AgentEntity.class);
        com.agenticform.operation.RepositoryRunbookDiscovery discovery =
                mock(com.agenticform.operation.RepositoryRunbookDiscovery.class);
        when(agents.findByRuntimeTypeAndRuntimeSessionId(RuntimeType.CODEX, "thread-1")).thenReturn(Optional.of(source));
        when(source.getId()).thenReturn(UUID.randomUUID());
        when(source.getProjectId()).thenReturn(UUID.randomUUID());
        when(source.getRole()).thenReturn(com.agenticform.agent.AgentRole.OPERATIONAL);
        when(source.getCapabilityProfile()).thenReturn(com.agenticform.agent.AgentCapabilityProfile.OPS);
        AgenticformDynamicToolHandler handler = new AgenticformDynamicToolHandler(
                mock(CodexJsonRpcClient.class), agents, mock(AgentMessageService.class),
                mock(HumanApprovalService.class), mock(PolicyRuleService.class),
                mock(OperationalRegistryService.class), mock(OperationRunService.class),
                new AgentCapabilityPolicy(), mock(OperationalSignalService.class),
                mock(OperationalIncidentService.class), mock(TaskDispatchService.class), discovery, new ObjectMapper());
        ObjectNode params = new ObjectMapper().createObjectNode()
                .put("namespace", "agenticform").put("threadId", "thread-1").put("tool", "propose_repository_runbook")
                .set("arguments", new ObjectMapper().createObjectNode());

        assertThrows(IllegalArgumentException.class, () -> handler.handle(request(params)));
        org.mockito.Mockito.verify(discovery, org.mockito.Mockito.never()).propose(any(), any(), any());
    }

    @Test
    void listRunbooksReportsTheRepositoryPlanSoTheOperationalAgentChecksTheRepositoryFirst() {
        AgentRepository agents = mock(AgentRepository.class);
        AgentEntity source = mock(AgentEntity.class);
        com.agenticform.operation.RepositoryRunbookDiscovery discovery =
                mock(com.agenticform.operation.RepositoryRunbookDiscovery.class);
        when(agents.findByRuntimeTypeAndRuntimeSessionId(RuntimeType.CODEX, "thread-1")).thenReturn(Optional.of(source));
        when(source.getProjectId()).thenReturn(UUID.randomUUID());
        when(source.getRole()).thenReturn(com.agenticform.agent.AgentRole.OPERATIONAL);
        when(source.getCapabilityProfile()).thenReturn(com.agenticform.agent.AgentCapabilityProfile.OPS);
        when(discovery.plan(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(new com.agenticform.operation.RepositoryRunbookDiscovery.Plan(
                        UUID.randomUUID(), com.agenticform.operation.RepositoryRunbookDiscovery.Source.REPOSITORY_MANIFEST,
                        com.agenticform.operation.RepositoryRunbookDiscovery.MANIFEST_PATH, "owner/repo", "abc123",
                        mock(com.agenticform.operation.OperationalEnvironmentEntity.class), "production-deploy",
                        "PRODUCTION_DEPLOY", "discovered", List.of(), false, null,
                        "PRODUCTION_DEPLOY remains REQUIRE_HUMAN: every run waits for a fresh operator approval."));
        AgenticformDynamicToolHandler handler = new AgenticformDynamicToolHandler(
                mock(CodexJsonRpcClient.class), agents, mock(AgentMessageService.class),
                mock(HumanApprovalService.class), mock(PolicyRuleService.class),
                mock(OperationalRegistryService.class), mock(OperationRunService.class),
                new AgentCapabilityPolicy(), mock(OperationalSignalService.class),
                mock(OperationalIncidentService.class), mock(TaskDispatchService.class), discovery, new ObjectMapper());
        ObjectNode params = new ObjectMapper().createObjectNode()
                .put("namespace", "agenticform").put("threadId", "thread-1").put("tool", "list_runbooks")
                .set("arguments", new ObjectMapper().createObjectNode());

        String responseText = handler.handle(request(params)).toCompletableFuture().join()
                .path("contentItems").get(0).path("text").asText();
        JsonNode plan = new ObjectMapper().readTree(responseText).path("repositoryPlan");

        assertEquals("REPOSITORY_MANIFEST", plan.path("source").asText());
        assertEquals("owner/repo", plan.path("repository").asText());
    }

    private AgenticformDynamicToolHandler handler(AgentRepository agents, AgentCapabilityPolicy policy) {
        return new AgenticformDynamicToolHandler(
                mock(CodexJsonRpcClient.class), agents, mock(AgentMessageService.class),
                mock(HumanApprovalService.class), mock(PolicyRuleService.class),
                mock(OperationalRegistryService.class), mock(OperationRunService.class), policy,
                mock(OperationalSignalService.class), mock(OperationalIncidentService.class),
                mock(TaskDispatchService.class), mock(com.agenticform.operation.RepositoryRunbookDiscovery.class), new ObjectMapper());
    }

    private CodexJsonRpcClient.ServerRequest request(ObjectNode params) {
        return new CodexJsonRpcClient.ServerRequest(new ObjectMapper().createObjectNode().put("id", 1),
                "item/tool/call", params);
    }
}
