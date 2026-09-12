package com.agenticform.agent;

import com.agenticform.approval.HumanApprovalRepository;
import com.agenticform.approval.HumanApprovalStatus;
import com.agenticform.event.ControlPlaneEventBus;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectService;
import com.agenticform.task.TaskDependencyService;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import com.agenticform.task.TaskStatus;
import com.agenticform.workspace.WorkspaceLifecycleService;
import com.agenticform.workspace.WorkspaceMode;
import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.runtime.RuntimeSession;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AgentLifecycleServiceTest {
    @Mock AgentRepository agents;
    @Mock TaskRepository tasks;
    @Mock TaskDependencyService dependencies;
    @Mock HumanApprovalRepository approvals;
    @Mock ProjectService projects;
    @Mock AgentRuntime runtime;
    @Mock AgentRuntimeRegistry runtimeRegistry;
    @Mock ExecutionNodeService nodes;
    @Mock WorkspaceLifecycleService workspaces;
    @Mock ControlPlaneEventBus events;
    @Mock AgentEntity agent;
    @Mock TaskEntity task;
    @Mock ProjectEntity project;

    private AgentLifecycleService lifecycle;

    @BeforeEach
    void setUp() {
        lifecycle = new AgentLifecycleService(agents, tasks, dependencies, approvals, projects,
                runtimeRegistry, nodes, workspaces, events);
        lenient().when(runtimeRegistry.get(any())).thenReturn(runtime);
    }

    @Test
    void localActiveAgentIsInterruptedTasksCancelledAndStopped() {
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        UUID taskId = UUID.randomUUID();
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getId()).thenReturn(agentId);
        when(agent.isSystemManaged()).thenReturn(false);
        when(agent.getStatus()).thenReturn(AgentStatus.WORKING);
        when(agent.getProjectId()).thenReturn(projectId);
        when(agent.getExecutionNodeId()).thenReturn(null);
        when(agent.getCodexThreadId()).thenReturn("thread-1");
        when(agent.getActiveTurnId()).thenReturn("turn-1");
        when(agent.getWorkspaceMode()).thenReturn(WorkspaceMode.SHARED_PROJECT);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(false);
        when(tasks.findAllByAssignedAgentIdOrderByCreatedAtAsc(agentId)).thenReturn(List.of(task));
        when(task.getStatus()).thenReturn(TaskStatus.RUNNING);
        when(task.getId()).thenReturn(taskId);

        lifecycle.stop(agentId);

        verify(agent).setQueueMode(AgentQueueMode.PAUSED);
        verify(task).setStatus(TaskStatus.CANCELLED);
        verify(tasks).save(task);
        verify(dependencies).reconcileDependents(taskId);
        verify(runtime).interrupt(new RuntimeSession("thread-1"), "turn-1");
        verify(agent).setActiveTaskId(null);
        verify(agent).setActiveTurnId(null);
        verify(agent).setStatus(AgentStatus.STOPPED);
        verify(events).publish("agent.stopped", projectId, agentId);
    }

    @Test
    void remoteActiveIsolatedAgentQueuesOnlyInterruptFirst() {
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getId()).thenReturn(agentId);
        when(agent.isSystemManaged()).thenReturn(false);
        when(agent.getStatus()).thenReturn(AgentStatus.WORKING);
        when(agent.getProjectId()).thenReturn(projectId);
        when(agent.getExecutionNodeId()).thenReturn(nodeId);
        when(agent.getRuntimeGeneration()).thenReturn(3L);
        when(agent.getCodexThreadId()).thenReturn("thread-3");
        when(agent.getActiveTurnId()).thenReturn("turn-3");
        when(agent.getWorkspaceMode()).thenReturn(WorkspaceMode.ISOLATED_WORKTREE);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(false);
        when(tasks.findAllByAssignedAgentIdOrderByCreatedAtAsc(agentId)).thenReturn(List.of());
        when(projects.get(projectId)).thenReturn(project);
        when(project.getDefaultBranch()).thenReturn("main");

        lifecycle.stop(agentId);

        verify(nodes).enqueue(eq(nodeId), eq(agentId), eq("INTERRUPT_TURN"),
                eq("stop-interrupt:" + agentId + ":g3"), anyMap());
        verify(nodes, never()).enqueue(eq(nodeId), eq(agentId), eq("CLEANUP_WORKSPACE"), any(), anyMap());
        verify(agent).setStatus(AgentStatus.STOPPING);
    }

    @Test
    void pendingApprovalPreventsPartialStop() {
        UUID agentId = UUID.randomUUID();
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.isSystemManaged()).thenReturn(false);
        when(agent.getStatus()).thenReturn(AgentStatus.WAITING_APPROVAL);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(true);

        assertThatThrownBy(() -> lifecycle.stop(agentId))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("pending human approval");

        verify(agent, never()).setQueueMode(any());
        verify(tasks, never()).findAllByAssignedAgentIdOrderByCreatedAtAsc(agentId);
    }

    @Test
    void systemManagedAgentCannotBeStopped() {
        UUID agentId = UUID.randomUUID();
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.isSystemManaged()).thenReturn(true);

        assertThatThrownBy(() -> lifecycle.stop(agentId))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("System-managed");
    }
}
