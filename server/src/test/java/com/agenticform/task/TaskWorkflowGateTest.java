package com.agenticform.task;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRole;
import com.agenticform.message.AgentMessageType;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

class TaskWorkflowGateTest {
    @Test
    void workRequestCannotWakeAgentWithoutRunnableTask() {
        TaskRepository tasks = mock(TaskRepository.class);
        TaskDependencyService dependencies = mock(TaskDependencyService.class);
        AgentEntity target = mock(AgentEntity.class);
        when(target.getActiveTaskId()).thenReturn(null);

        TaskWorkflowGate gate = new TaskWorkflowGate(tasks, dependencies);

        assertThrows(IllegalStateException.class,
                () -> gate.requireMessageTargetReady(target, AgentMessageType.REVIEW_REQUEST));
        verifyNoInteractions(tasks, dependencies);
    }

    @Test
    void workRequestRequiresAssignedRunnableTaskAndReadyDependencies() {
        TaskRepository tasks = mock(TaskRepository.class);
        TaskDependencyService dependencies = mock(TaskDependencyService.class);
        AgentEntity target = mock(AgentEntity.class);
        TaskEntity task = mock(TaskEntity.class);
        UUID agentId = UUID.randomUUID();
        UUID taskId = UUID.randomUUID();

        when(target.getId()).thenReturn(agentId);
        when(target.getActiveTaskId()).thenReturn(taskId);
        when(tasks.findById(taskId)).thenReturn(Optional.of(task));
        when(task.getAssignedAgentId()).thenReturn(agentId);
        when(task.getStatus()).thenReturn(TaskStatus.RUNNING);
        doThrow(new IllegalStateException("waiting")).when(dependencies).requireReady(taskId);

        TaskWorkflowGate gate = new TaskWorkflowGate(tasks, dependencies);

        assertThrows(IllegalStateException.class,
                () -> gate.requireMessageTargetReady(target, AgentMessageType.REQUEST));
        verify(dependencies).requireReady(taskId);
    }

    @Test
    void informationalMessageDoesNotRequireTask() {
        TaskWorkflowGate gate = new TaskWorkflowGate(mock(TaskRepository.class), mock(TaskDependencyService.class));
        AgentEntity target = mock(AgentEntity.class);

        assertDoesNotThrow(() -> gate.requireMessageTargetReady(target, AgentMessageType.INFORMATION));
    }

    @Test
    void operationalHandoffDoesNotRequireNormalTask() {
        TaskWorkflowGate gate = new TaskWorkflowGate(mock(TaskRepository.class), mock(TaskDependencyService.class));
        AgentEntity target = mock(AgentEntity.class);
        when(target.getRole()).thenReturn(AgentRole.OPERATIONAL);

        assertDoesNotThrow(() -> gate.requireMessageTargetReady(target, AgentMessageType.HANDOFF));
    }
}
