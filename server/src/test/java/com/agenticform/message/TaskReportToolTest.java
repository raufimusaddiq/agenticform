package com.agenticform.message;

import com.agenticform.agent.*;
import com.agenticform.approval.HumanApprovalService;
import com.agenticform.codex.CodexJsonRpcClient;
import com.agenticform.operation.*;
import com.agenticform.policy.PolicyRuleService;
import com.agenticform.runtime.RuntimeType;
import com.agenticform.task.TaskDispatchService;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class TaskReportToolTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final UUID agentId = UUID.randomUUID();
    private final AgentRepository agents = mock(AgentRepository.class);
    private final AgentEntity source = mock(AgentEntity.class);
    private final TaskDispatchService tasks = mock(TaskDispatchService.class);
    private final AgentMessageService messages = mock(AgentMessageService.class);
    private final AgenticformDynamicToolHandler handler = new AgenticformDynamicToolHandler(
            mock(CodexJsonRpcClient.class), agents, messages, mock(HumanApprovalService.class),
            mock(PolicyRuleService.class), mock(OperationalRegistryService.class), mock(OperationRunService.class),
            new AgentCapabilityPolicy(), mock(OperationalSignalService.class), mock(OperationalIncidentService.class),
            tasks, mock(com.agenticform.operation.RepositoryRunbookDiscovery.class), mapper);

    TaskReportToolTest() {
        when(agents.findByRuntimeTypeAndRuntimeSessionId(RuntimeType.CODEX, "thread-1")).thenReturn(Optional.of(source));
        when(source.getId()).thenReturn(agentId);
        when(source.getRole()).thenReturn(AgentRole.GENERAL);
        when(source.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.IMPLEMENTER);
    }

    private JsonNode call(String tool, ObjectNode arguments) {
        ObjectNode params = mapper.createObjectNode().put("namespace", "agenticform")
                .put("threadId", "thread-1").put("tool", tool).set("arguments", arguments);
        return handler.handle(new CodexJsonRpcClient.ServerRequest(mapper.valueToTree(1), "item/tool/call", params))
                .toCompletableFuture().join();
    }

    @Test
    void reportAndBlockSchemasRequireDispatchIdentity() {
        JsonNode tools = new com.agenticform.codex.CodexThreadConfiguration(mapper).tools().get(0).path("tools");
        int checked = 0;
        for (JsonNode tool : tools) {
            if (!java.util.Set.of("report_task", "block_task").contains(tool.path("name").asText())) continue;
            JsonNode required = tool.path("inputSchema").path("required");
            assertTrue(required.toString().contains("taskId"));
            assertTrue(required.toString().contains("runtimeGeneration"));
            checked++;
        }
        assertEquals(2, checked);
    }

    @Test
    void missingOrMalformedIdentityNeverInfersCurrentTask() {
        for (String tool : new String[]{"report_task", "block_task"}) {
            ObjectNode args = mapper.createObjectNode().put("report", "done").put("reason", "blocked");
            assertEquals("REPORT_IDENTITY_REQUIRED", call(tool, args).path("code").asText());
            args.put("taskId", UUID.randomUUID().toString()).put("runtimeGeneration", "3");
            assertEquals("REPORT_IDENTITY_REQUIRED", call(tool, args).path("code").asText());
            args.put("runtimeGeneration", 1.5);
            assertEquals("REPORT_IDENTITY_REQUIRED", call(tool, args).path("code").asText());
        }
        verifyNoInteractions(tasks);
    }

    @Test
    void staleReportReturnsOriginalAndCurrentTaskReferences() {
        UUID original = UUID.randomUUID();
        UUID current = UUID.randomUUID();
        when(tasks.report(agentId, original, 2L, "late", null)).thenThrow(
                new TaskDispatchService.ReportRejectedException("STALE_TASK", original, current, "Inspect original task"));
        JsonNode result = call("report_task", mapper.createObjectNode().put("taskId", original.toString())
                .put("runtimeGeneration", 2).put("report", "late"));
        assertFalse(result.path("success").asBoolean());
        assertEquals("STALE_TASK", result.path("code").asText());
        assertEquals(original.toString(), result.path("taskId").asText());
        assertEquals(current.toString(), result.path("activeTaskId").asText());
        assertEquals("Inspect original task", result.path("nextAction").asText());
        String modelVisible = result.path("contentItems").get(0).path("text").asText();
        assertTrue(modelVisible.contains("STALE_TASK"));
        assertTrue(modelVisible.contains(original.toString()));
        assertTrue(modelVisible.contains(current.toString()));
    }

    @Test
    void operationalTaskCreationReturnsDedicatedHandoffAction() {
        UUID targetId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        AgentEntity target = mock(AgentEntity.class);
        when(source.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.ORCHESTRATOR);
        when(source.getProjectId()).thenReturn(projectId);
        when(agents.findById(targetId)).thenReturn(Optional.of(target));
        when(target.getProjectId()).thenReturn(projectId);
        when(target.getRole()).thenReturn(AgentRole.OPERATIONAL);
        JsonNode result = call("create_task", mapper.createObjectNode().put("agentId", targetId.toString()));
        assertEquals("OPERATIONS_HANDOFF_REQUIRED", result.path("code").asText());
        assertEquals(targetId.toString(), result.path("operationalAgentId").asText());
        assertTrue(result.path("nextAction").asText().contains("handoff_to_operations"));
        verifyNoInteractions(tasks);
    }

    @Test
    void resultAndBlockerMessagesNeverImplicitlyMutateTasks() {
        UUID target = UUID.randomUUID();
        AgentMessageEntity message = mock(AgentMessageEntity.class);
        when(message.getId()).thenReturn(UUID.randomUUID());
        when(message.getConversationId()).thenReturn(UUID.randomUUID());
        when(message.getAudienceType()).thenReturn(AgentMessageAudienceType.DIRECT);
        when(message.getStatus()).thenReturn(AgentMessageStatus.CREATED);
        for (AgentMessageType type : new AgentMessageType[]{AgentMessageType.RESULT, AgentMessageType.REVIEW_RESULT, AgentMessageType.BLOCKER}) {
            when(messages.send(agentId, target, type, "subject", "content", null)).thenReturn(message);
            JsonNode result = call("send_message", mapper.createObjectNode().put("targetAgentId", target.toString())
                    .put("type", type.name()).put("subject", "subject").put("content", "content"));
            assertTrue(result.path("success").asBoolean());
        }
        verifyNoInteractions(tasks);
    }
}
