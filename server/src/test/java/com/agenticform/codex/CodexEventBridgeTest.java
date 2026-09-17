package com.agenticform.codex;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.event.ControlPlaneEventBus;
import com.agenticform.message.AgentMessageDeliveryEntity;
import com.agenticform.message.AgentMessageDeliveryRepository;
import com.agenticform.message.AgentMessageService;
import com.agenticform.message.AgentMessageStatus;
import com.agenticform.runtime.RuntimeType;
import com.agenticform.task.TaskDependencyService;
import com.agenticform.task.TaskDispatchService;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class CodexEventBridgeTest {
    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    void anonymousStartedTurnBindsDispatchedMessageDelivery() throws Exception {
        UUID nodeId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        UUID deliveryId = UUID.randomUUID();
        UUID messageId = UUID.randomUUID();
        String session = "thread-1";
        AgentEntity agent = mock(AgentEntity.class);
        when(agent.getId()).thenReturn(agentId);
        when(agent.ownsRuntime(eq(nodeId), eq(5L), eq(RuntimeType.CODEX), eq(session))).thenReturn(true);
        when(agent.getStatus()).thenReturn(com.agenticform.agent.AgentStatus.WORKING);
        when(agent.getProjectId()).thenReturn(UUID.randomUUID());
        AgentRepository agents = mock(AgentRepository.class);
        when(agents.findByRuntimeTypeAndRuntimeSessionId(RuntimeType.CODEX, session)).thenReturn(Optional.of(agent));
        AgentMessageDeliveryEntity delivery = mock(AgentMessageDeliveryEntity.class);
        when(delivery.getToAgentId()).thenReturn(agentId);
        when(delivery.getId()).thenReturn(deliveryId);
        when(delivery.getMessageId()).thenReturn(messageId);
        AgentMessageDeliveryRepository deliveries = mock(AgentMessageDeliveryRepository.class);
        when(deliveries.findFirstByToAgentIdAndStatusOrderByCreatedAtAsc(agentId, AgentMessageStatus.DISPATCHED))
                .thenReturn(Optional.of(delivery));
        AgentMessageService messages = mock(AgentMessageService.class);
        TaskRepository tasks = mock(TaskRepository.class);
        ControlPlaneEventBus events = new ControlPlaneEventBus();
        CodexEventBridge bridge = new CodexEventBridge(mock(CodexJsonRpcClient.class), tasks, agents,
                deliveries, messages, mock(TaskDependencyService.class), mock(TaskDispatchService.class), events);
        String params = """
                {"turnId":"turn-1","item":{"type":"commandExecution"}}
                """;
        bridge.handleRemote(nodeId, 5L, RuntimeType.CODEX, session,
                new CodexJsonRpcClient.Notification("item/started", mapper.readTree(params)));
        verify(deliveries).save(delivery);
        verify(delivery).markProcessing("turn-1");
    }

    @Test
    void turnCompletionWithExistingErrorKeepsBlockerInsteadOfGenericMissingReport() throws Exception {
        UUID nodeId = UUID.randomUUID();
        UUID taskId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        String session = "thread-2";
        AgentEntity agent = mock(AgentEntity.class);
        when(agent.ownsRuntime(eq(nodeId), eq(6L), eq(RuntimeType.CODEX), eq(session))).thenReturn(true);
        when(agent.getStatus()).thenReturn(com.agenticform.agent.AgentStatus.WORKING);
        when(agent.getProjectId()).thenReturn(UUID.randomUUID());
        TaskEntity task = mock(TaskEntity.class);
        when(task.getAssignedAgentId()).thenReturn(agentId);
        when(task.getStatus()).thenReturn(com.agenticform.task.TaskStatus.RUNNING);
        when(task.getTurnId()).thenReturn("turn-2");
        when(task.getReport()).thenReturn(null);
        when(task.getLastError()).thenReturn("DELIVERY_CONFIGURATION_REQUIRED");
        AgentRepository agents = mock(AgentRepository.class);
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        TaskRepository tasks = mock(TaskRepository.class);
        when(tasks.findByTurnId("turn-2")).thenReturn(Optional.of(task));
        AgentMessageDeliveryRepository deliveries = mock(AgentMessageDeliveryRepository.class);
        when(deliveries.findByTurnId("turn-2")).thenReturn(Optional.empty());
        ControlPlaneEventBus events = new ControlPlaneEventBus();
        CodexEventBridge bridge = new CodexEventBridge(mock(CodexJsonRpcClient.class), tasks, agents,
                deliveries, mock(AgentMessageService.class), mock(TaskDependencyService.class),
                mock(TaskDispatchService.class), events);
        String params = """
                {"turn":{"id":"turn-2","status":"completed"}}
                """;
        bridge.handleRemote(nodeId, 6L, RuntimeType.CODEX, session,
                new CodexJsonRpcClient.Notification("turn/completed", mapper.readTree(params)));
        verify(task).setStatus(com.agenticform.task.TaskStatus.BLOCKED);
        verify(tasks).save(task);
    }
}
