package com.agenticform.task;

import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskDependencyServiceTest {
    private final TaskRepository tasks = mock(TaskRepository.class);
    private final TaskDependencyRepository dependencies = mock(TaskDependencyRepository.class);
    private final TaskDependencyService service = new TaskDependencyService(tasks, dependencies);

    @Test
    void rejectsTransitiveCycle() {
        UUID project = UUID.randomUUID();
        TaskEntity a = task(project, TaskStatus.READY);
        TaskEntity b = task(project, TaskStatus.READY);
        TaskEntity c = task(project, TaskStatus.READY);
        when(tasks.findById(a.getId())).thenReturn(Optional.of(a));
        when(tasks.findById(c.getId())).thenReturn(Optional.of(c));
        when(dependencies.existsByTaskIdAndDependsOnTaskId(a.getId(), c.getId())).thenReturn(false);
        when(dependencies.findAllByTaskId(c.getId())).thenReturn(List.of(
                new TaskDependencyEntity(c.getId(), b.getId(), TaskDependencyType.REQUIRES_SUCCESS)));
        when(dependencies.findAllByTaskId(b.getId())).thenReturn(List.of(
                new TaskDependencyEntity(b.getId(), a.getId(), TaskDependencyType.REQUIRES_SUCCESS)));

        assertThatThrownBy(() -> service.add(a.getId(), c.getId(), TaskDependencyType.REQUIRES_SUCCESS))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("cycle");
    }

    @Test
    void successDependencyWaitsUntilPrerequisiteCompletes() {
        UUID project = UUID.randomUUID();
        TaskEntity downstream = task(project, TaskStatus.READY);
        TaskEntity upstream = task(project, TaskStatus.RUNNING);
        when(tasks.findById(downstream.getId())).thenReturn(Optional.of(downstream));
        when(tasks.findById(upstream.getId())).thenReturn(Optional.of(upstream));
        when(dependencies.findAllByTaskId(downstream.getId())).thenReturn(List.of(
                new TaskDependencyEntity(downstream.getId(), upstream.getId(), TaskDependencyType.REQUIRES_SUCCESS)));

        assertThat(service.evaluate(downstream.getId()).state()).isEqualTo(TaskDependencyService.State.WAITING);
        service.reconcile(downstream.getId());
        assertThat(downstream.getDependencyReason()).contains(upstream.getId().toString());

        upstream.setStatus(TaskStatus.COMPLETED);
        assertThat(service.evaluate(downstream.getId()).state()).isEqualTo(TaskDependencyService.State.READY);
        service.reconcile(downstream.getId());
        assertThat(downstream.getDependencyReason()).isNull();
        assertThat(downstream.getLastError()).isNull();
    }

    @Test
    void failedPrerequisiteBlocksSuccessDependencyButSatisfiesCompletionDependency() {
        UUID project = UUID.randomUUID();
        TaskEntity downstream = task(project, TaskStatus.READY);
        TaskEntity upstream = task(project, TaskStatus.FAILED);
        when(tasks.findById(downstream.getId())).thenReturn(Optional.of(downstream));
        when(tasks.findById(upstream.getId())).thenReturn(Optional.of(upstream));
        when(dependencies.findAllByTaskId(downstream.getId())).thenReturn(List.of(
                new TaskDependencyEntity(downstream.getId(), upstream.getId(), TaskDependencyType.REQUIRES_SUCCESS)));

        assertThat(service.evaluate(downstream.getId()).state()).isEqualTo(TaskDependencyService.State.BLOCKED);

        when(dependencies.findAllByTaskId(downstream.getId())).thenReturn(List.of(
                new TaskDependencyEntity(downstream.getId(), upstream.getId(), TaskDependencyType.REQUIRES_COMPLETION)));
        assertThat(service.evaluate(downstream.getId()).state()).isEqualTo(TaskDependencyService.State.READY);
    }

    @Test
    void infrastructureBlockedPrerequisiteFailsSuccessDependencyInsteadOfWaitingForever() {
        UUID project = UUID.randomUUID();
        TaskEntity downstream = task(project, TaskStatus.WAITING_DEPENDENCY);
        TaskEntity upstream = task(project, TaskStatus.BLOCKED);
        upstream.setLastError("Execution node was lost; task will resume after runtime rehydration");
        when(tasks.findById(downstream.getId())).thenReturn(Optional.of(downstream));
        when(tasks.findById(upstream.getId())).thenReturn(Optional.of(upstream));
        when(dependencies.findAllByTaskId(downstream.getId())).thenReturn(List.of(
                new TaskDependencyEntity(downstream.getId(), upstream.getId(), TaskDependencyType.REQUIRES_SUCCESS)));

        assertThat(service.evaluate(downstream.getId()).state()).isEqualTo(TaskDependencyService.State.BLOCKED);
        service.reconcile(downstream.getId());
        assertThat(downstream.getStatus()).isEqualTo(TaskStatus.BLOCKED);
        assertThat(downstream.getLastError()).startsWith("Dependency failed:");
    }

    @Test
    void blocksRelationshipWaitsForAnyTerminalOutcome() {
        UUID project = UUID.randomUUID();
        TaskEntity downstream = task(project, TaskStatus.READY);
        TaskEntity upstream = task(project, TaskStatus.RUNNING);
        when(tasks.findById(downstream.getId())).thenReturn(Optional.of(downstream));
        when(tasks.findById(upstream.getId())).thenReturn(Optional.of(upstream));
        when(dependencies.findAllByTaskId(downstream.getId())).thenReturn(List.of(
                new TaskDependencyEntity(downstream.getId(), upstream.getId(), TaskDependencyType.BLOCKS)));

        assertThat(service.evaluate(downstream.getId()).state()).isEqualTo(TaskDependencyService.State.WAITING);
        upstream.setStatus(TaskStatus.CANCELLED);
        assertThat(service.evaluate(downstream.getId()).state()).isEqualTo(TaskDependencyService.State.READY);
    }

    @Test
    void dependencyFailurePropagatesThroughMultipleLevels() {
        UUID project = UUID.randomUUID();
        TaskEntity a = task(project, TaskStatus.FAILED);
        TaskEntity b = task(project, TaskStatus.WAITING_DEPENDENCY);
        TaskEntity c = task(project, TaskStatus.WAITING_DEPENDENCY);

        when(tasks.findById(a.getId())).thenReturn(Optional.of(a));
        when(tasks.findById(b.getId())).thenReturn(Optional.of(b));
        when(tasks.findById(c.getId())).thenReturn(Optional.of(c));
        when(dependencies.findAllByTaskId(b.getId())).thenReturn(List.of(
                new TaskDependencyEntity(b.getId(), a.getId(), TaskDependencyType.REQUIRES_SUCCESS)));
        when(dependencies.findAllByTaskId(c.getId())).thenReturn(List.of(
                new TaskDependencyEntity(c.getId(), b.getId(), TaskDependencyType.REQUIRES_SUCCESS)));
        when(dependencies.findAllByDependsOnTaskId(b.getId())).thenReturn(List.of(
                new TaskDependencyEntity(c.getId(), b.getId(), TaskDependencyType.REQUIRES_SUCCESS)));
        when(dependencies.findAllByDependsOnTaskId(c.getId())).thenReturn(List.of());

        service.reconcile(b.getId());

        assertThat(b.getStatus()).isEqualTo(TaskStatus.BLOCKED);
        assertThat(b.getLastError()).startsWith("Dependency failed:");
        assertThat(c.getStatus()).isEqualTo(TaskStatus.BLOCKED);
        assertThat(c.getLastError()).startsWith("Dependency failed:");
        verify(tasks).save(b);
        verify(tasks).save(c);
    }

    @Test
    void completionDependencyTreatsPropagatedDependencyBlockAsTerminal() {
        UUID project = UUID.randomUUID();
        TaskEntity downstream = task(project, TaskStatus.WAITING_DEPENDENCY);
        TaskEntity upstream = task(project, TaskStatus.BLOCKED);
        upstream.setLastError("Dependency failed: prerequisite failed");
        when(tasks.findById(downstream.getId())).thenReturn(Optional.of(downstream));
        when(tasks.findById(upstream.getId())).thenReturn(Optional.of(upstream));
        when(dependencies.findAllByTaskId(downstream.getId())).thenReturn(List.of(
                new TaskDependencyEntity(downstream.getId(), upstream.getId(), TaskDependencyType.REQUIRES_COMPLETION)));

        assertThat(service.evaluate(downstream.getId()).state()).isEqualTo(TaskDependencyService.State.READY);
    }

    private TaskEntity task(UUID projectId, TaskStatus status) {
        TaskEntity task = new TaskEntity(projectId, UUID.randomUUID(), "task", "prompt", 0);
        ReflectionTestUtils.setField(task, "id", UUID.randomUUID());
        task.setStatus(status);
        return task;
    }
}
