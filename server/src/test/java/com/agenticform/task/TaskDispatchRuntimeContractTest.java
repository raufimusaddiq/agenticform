package com.agenticform.task;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.agent.AgentStatus;
import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.runtime.RuntimeDispatchReceipt;
import com.agenticform.runtime.RuntimeSession;
import com.agenticform.node.ExecutionNodeService;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskDispatchRuntimeContractTest {
    @Test
    void dispatchUsesOpaqueRuntimeSessionWithoutCodexGateway() {
        TaskRepository tasks = mock(TaskRepository.class);
        AgentRepository agents = mock(AgentRepository.class);
        AgentRuntime runtime = mock(AgentRuntime.class);
        AgentRuntimeRegistry runtimeRegistry = mock(AgentRuntimeRegistry.class);
        ExecutionNodeService nodes = mock(ExecutionNodeService.class);
        TaskDependencyService dependencies = mock(TaskDependencyService.class);

        UUID taskId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        TaskEntity task = mock(TaskEntity.class);
        AgentEntity agent = mock(AgentEntity.class);
        when(tasks.findById(taskId)).thenReturn(Optional.of(task));
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(task.getId()).thenReturn(taskId);
        when(task.getAssignedAgentId()).thenReturn(agentId);
        when(task.getStatus()).thenReturn(TaskStatus.READY);
        when(task.getPrompt()).thenReturn("inspect");
        when(agent.getRole()).thenReturn(AgentRole.GENERAL);
        when(agent.isSystemManaged()).thenReturn(false);
        when(agent.getStatus()).thenReturn(AgentStatus.IDLE);
        when(agent.getExecutionNodeId()).thenReturn(null);
        when(agent.getRuntimeSessionId()).thenReturn("opaque-session-1");
        when(runtimeRegistry.get(any())).thenReturn(runtime);
        when(dependencies.reconcile(taskId)).thenReturn(new TaskDependencyService.Evaluation(
                TaskDependencyService.State.READY, null));
        when(runtime.dispatch(any(RuntimeSession.class), eq("agenticform-task:" + taskId),
                eq(TaskDispatchService.promptWithCompletionContract("inspect"))))
                .thenReturn(new RuntimeDispatchReceipt("queue-1", "turn-1"));

        new TaskDispatchService(tasks, agents, runtimeRegistry, nodes, dependencies).dispatchManually(taskId);

        verify(runtime).dispatch(new RuntimeSession("opaque-session-1"),
                "agenticform-task:" + taskId, TaskDispatchService.promptWithCompletionContract("inspect"));
        verify(task).setQueuedSubmissionId("queue-1");
        verify(task).setTurnId("turn-1");
    }
}
