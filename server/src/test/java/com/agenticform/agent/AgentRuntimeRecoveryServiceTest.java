package com.agenticform.agent;

import com.agenticform.approval.HumanApprovalRepository;
import com.agenticform.approval.HumanApprovalStatus;
import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.node.ExecutionNodeEntity;
import com.agenticform.node.ExecutionNodeScheduler;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.node.ExecutionNodeStatus;
import com.agenticform.node.NodeTrustLevel;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectService;
import com.agenticform.project.ProjectSourceType;
import com.agenticform.task.TaskRepository;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskStatus;
import com.agenticform.workspace.WorkspaceMode;
import com.agenticform.runtime.RuntimeType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AgentRuntimeRecoveryServiceTest {
    @Mock AgentRepository agents;
    @Mock ProjectService projects;
    @Mock TaskRepository tasks;
    @Mock HumanApprovalRepository approvals;
    @Mock ExecutionNodeScheduler scheduler;
    @Mock ExecutionNodeService nodeService;
    @Mock AgentRuntimeRegistry runtimeRegistry;
    @Mock AgentRuntime runtime;
    @Mock AgentEntity agent;
    @Mock ProjectEntity project;
    @Mock ExecutionNodeEntity oldNode;
    @Mock ExecutionNodeEntity replacement;

    private AgentRuntimeRecoveryService service;

    @BeforeEach
    void setUp() {
        service = new AgentRuntimeRecoveryService(agents, projects, tasks, approvals, scheduler,
                nodeService, runtimeRegistry);
    }

    @Test
    void recoveryResetsAmbiguousActiveTaskInsteadOfReplaying() {
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        UUID taskId = UUID.randomUUID();
        TaskEntity activeTask = org.mockito.Mockito.mock(TaskEntity.class);
        org.mockito.Mockito.when(activeTask.getId()).thenReturn(taskId);
        org.mockito.Mockito.when(activeTask.getStatus()).thenReturn(TaskStatus.RUNNING);

        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getId()).thenReturn(agentId);
        when(agent.getExecutionNodeId()).thenReturn(nodeId);
        when(agent.getStatus()).thenReturn(AgentStatus.DISCONNECTED);
        when(agent.getProjectId()).thenReturn(projectId);
        when(agent.getRuntimeGeneration()).thenReturn(1L);
        when(agent.getName()).thenReturn("Coder");
        when(agent.getBranch()).thenReturn("agent/coder");
        when(agent.getActiveTaskId()).thenReturn(taskId);
        when(agent.getWorkspaceMode()).thenReturn(WorkspaceMode.ISOLATED_WORKTREE);
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.IMPLEMENTER);
        when(agent.getResponsibility()).thenReturn("Implement features");
        when(agent.reassignRuntime(eq(nodeId), any())).thenReturn(2L);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(false);
        when(projects.get(projectId)).thenReturn(project);
        when(project.getSourceType()).thenReturn(ProjectSourceType.GIT);
        when(project.getId()).thenReturn(projectId);
        when(project.getSlug()).thenReturn("demo");
        when(project.getRepositoryUrl()).thenReturn("https://github.com/acme/demo.git");
        when(project.getDefaultBranch()).thenReturn("main");
        when(nodeService.get(nodeId)).thenReturn(oldNode);
        when(oldNode.getId()).thenReturn(nodeId);
        when(oldNode.getStatus()).thenReturn(ExecutionNodeStatus.ONLINE);
        when(tasks.findById(taskId)).thenReturn(Optional.of(activeTask));
        when(runtimeRegistry.get(RuntimeType.CODEX)).thenReturn(runtime);
        when(runtime.startParameters("", "Implement features", AgentCapabilityProfile.IMPLEMENTER)).thenReturn(Map.of());

        service.recover(agentId);

        verify(activeTask).setStatus(TaskStatus.BLOCKED);
        verify(activeTask).setQueuedSubmissionId(null);
        verify(activeTask).setTurnId(null);
        verify(activeTask).setLastError(org.mockito.ArgumentMatchers.contains("lost"));
    }

    @Test
    void pendingHumanApprovalBlocksRuntimeMovement() {
        UUID agentId = UUID.randomUUID();
        UUID oldNodeId = UUID.randomUUID();
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getExecutionNodeId()).thenReturn(oldNodeId);
        when(agent.getStatus()).thenReturn(AgentStatus.DISCONNECTED);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(true);

        assertThrows(IllegalStateException.class, () -> service.recover(agentId));
        verify(scheduler, never()).select(any(), any(), any(), any());
    }

    @Test
    void recoveryMovesToDifferentNodeAndIncrementsGeneration() {
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        UUID oldNodeId = UUID.randomUUID();
        UUID newNodeId = UUID.randomUUID();

        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getId()).thenReturn(agentId);
        when(agent.getExecutionNodeId()).thenReturn(oldNodeId);
        when(agent.getStatus()).thenReturn(AgentStatus.DISCONNECTED);
        when(agent.getProjectId()).thenReturn(projectId);
        when(agent.getRuntimeGeneration()).thenReturn(1L);
        when(agent.getName()).thenReturn("Coder");
        when(agent.getBranch()).thenReturn("agent/coder");
        when(agent.getActiveTaskId()).thenReturn(null);
        when(agent.getWorkspaceMode()).thenReturn(WorkspaceMode.ISOLATED_WORKTREE);
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.IMPLEMENTER);
        when(agent.getResponsibility()).thenReturn("Implement features");
        when(agent.reassignRuntime(eq(newNodeId), any())).thenReturn(2L);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(false);

        when(projects.get(projectId)).thenReturn(project);
        when(project.getSourceType()).thenReturn(ProjectSourceType.GIT);
        when(project.getId()).thenReturn(projectId);
        when(project.getSlug()).thenReturn("demo");
        when(project.getRepositoryUrl()).thenReturn("https://github.com/acme/demo.git");
        when(project.getDefaultBranch()).thenReturn("main");

        when(nodeService.get(oldNodeId)).thenReturn(oldNode);
        when(oldNode.getStatus()).thenReturn(ExecutionNodeStatus.OFFLINE);
        when(replacement.getId()).thenReturn(newNodeId);
        when(scheduler.select(null, NodeTrustLevel.STANDARD, Set.of("runtime:CODEX", "git"), Set.of(oldNodeId)))
                .thenReturn(replacement);
        when(runtimeRegistry.get(RuntimeType.CODEX)).thenReturn(runtime);
        when(runtime.startParameters("", "Implement features", AgentCapabilityProfile.IMPLEMENTER)).thenReturn(Map.of());

        AgentEntity recovered = service.recover(agentId);

        assertEquals(agent, recovered);
        verify(agent).reassignRuntime(eq(newNodeId), any());
        verify(agents).save(agent);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, ?>> payload = ArgumentCaptor.forClass(Map.class);
        verify(nodeService).enqueue(eq(newNodeId), eq(agentId), eq("START_AGENT"),
                eq("start-agent:" + agentId + ":g2"), payload.capture());
        assertEquals(projectId.toString(), payload.getValue().get("projectId"));
        assertEquals(oldNodeId.toString(), payload.getValue().get("previousNodeId"));
        assertEquals(true, payload.getValue().get("recovery"));
        // Operator branches survive node loss; recovery branches must not silently
        // move an agent off the branch it was implementing or reviewing.
        assertEquals("agent/coder", payload.getValue().get("requestedBranch"));
    }

    @Test
    void recoveryRemintsBranchWhenRecordedBranchIsSynthetic() {
        UUID agentId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        UUID oldNodeId = UUID.randomUUID();
        UUID newNodeId = UUID.randomUUID();

        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getId()).thenReturn(agentId);
        when(agent.getExecutionNodeId()).thenReturn(oldNodeId);
        when(agent.getStatus()).thenReturn(AgentStatus.DISCONNECTED);
        when(agent.getProjectId()).thenReturn(projectId);
        when(agent.getRuntimeGeneration()).thenReturn(3L);
        when(agent.getName()).thenReturn("Reviewer");
        when(agent.getBranch()).thenReturn("recovery/reviewer-42424242-g3");
        when(agent.getActiveTaskId()).thenReturn(null);
        when(agent.getWorkspaceMode()).thenReturn(WorkspaceMode.ISOLATED_WORKTREE);
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.REVIEWER);
        when(agent.getResponsibility()).thenReturn("Review changes");
        when(agent.reassignRuntime(eq(newNodeId), any())).thenReturn(4L);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(false);

        when(projects.get(projectId)).thenReturn(project);
        when(project.getSourceType()).thenReturn(ProjectSourceType.GIT);
        when(project.getId()).thenReturn(projectId);
        when(project.getSlug()).thenReturn("demo");
        when(project.getRepositoryUrl()).thenReturn("https://github.com/acme/demo.git");
        when(project.getDefaultBranch()).thenReturn("main");

        when(nodeService.get(oldNodeId)).thenReturn(oldNode);
        when(oldNode.getStatus()).thenReturn(ExecutionNodeStatus.OFFLINE);
        when(replacement.getId()).thenReturn(newNodeId);
        when(scheduler.select(null, NodeTrustLevel.STANDARD, Set.of("runtime:CODEX", "git"), Set.of(oldNodeId)))
                .thenReturn(replacement);
        when(runtimeRegistry.get(RuntimeType.CODEX)).thenReturn(runtime);
        when(runtime.startParameters("", "Review changes", AgentCapabilityProfile.REVIEWER)).thenReturn(Map.of());

        service.recover(agentId);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, ?>> payload = ArgumentCaptor.forClass(Map.class);
        verify(nodeService).enqueue(eq(newNodeId), eq(agentId), eq("START_AGENT"),
                eq("start-agent:" + agentId + ":g4"), payload.capture());
        // Without a recorded base branch, recovery falls back to the project default
        // branch rather than minting an unusable synthetic recovery branch.
        assertEquals("main", payload.getValue().get("requestedBranch"));
    }

    @Test
    void cleanupFailedUnboundRuntimeOmitsSessionId() {
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getId()).thenReturn(agentId);
        when(agent.getExecutionNodeId()).thenReturn(nodeId);
        when(agent.getWorkspaceMode()).thenReturn(WorkspaceMode.ISOLATED_WORKTREE);
        when(agent.getActiveTaskId()).thenReturn(null);
        when(agent.getActiveTurnId()).thenReturn(null);
        when(agent.getStatus()).thenReturn(AgentStatus.FAILED);
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.getRuntimeSessionId()).thenReturn(null);
        when(agent.getRuntimeGeneration()).thenReturn(2L);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(false);
        when(nodeService.get(nodeId)).thenReturn(replacement);
        when(replacement.getId()).thenReturn(nodeId);
        when(replacement.getStatus()).thenReturn(ExecutionNodeStatus.ONLINE);
        when(agents.save(agent)).thenReturn(agent);

        service.cleanup(agentId);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, ?>> payload = ArgumentCaptor.forClass(Map.class);
        verify(nodeService).enqueue(eq(nodeId), eq(agentId), eq("CLEANUP_WORKSPACE"),
                eq("cleanup-runtime:" + agentId + ":g2"), payload.capture());
        assertEquals("CODEX", payload.getValue().get("runtimeType"));
        assertTrue(!payload.getValue().containsKey("runtimeSessionId"));
    }

    @Test
    void recoveryReusesOnlineNodeAfterDaemonRestart() {
        UUID agentId = UUID.randomUUID();
        UUID nodeId = UUID.randomUUID();
        UUID projectId = UUID.randomUUID();
        when(agents.findById(agentId)).thenReturn(Optional.of(agent));
        when(agent.getId()).thenReturn(agentId);
        when(agent.getExecutionNodeId()).thenReturn(nodeId);
        when(agent.getStatus()).thenReturn(AgentStatus.DISCONNECTED);
        when(agent.getProjectId()).thenReturn(projectId);
        when(agent.getRuntimeGeneration()).thenReturn(1L);
        when(agent.getName()).thenReturn("Coder");
        when(agent.getBranch()).thenReturn("agent/coder");
        when(agent.getActiveTaskId()).thenReturn(null);
        when(agent.getWorkspaceMode()).thenReturn(WorkspaceMode.ISOLATED_WORKTREE);
        when(agent.getRuntimeType()).thenReturn(RuntimeType.CODEX);
        when(agent.getCapabilityProfile()).thenReturn(AgentCapabilityProfile.IMPLEMENTER);
        when(agent.getResponsibility()).thenReturn("Implement features");
        when(agent.reassignRuntime(eq(nodeId), any())).thenReturn(2L);
        when(approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)).thenReturn(false);
        when(projects.get(projectId)).thenReturn(project);
        when(project.getSourceType()).thenReturn(ProjectSourceType.GIT);
        when(project.getId()).thenReturn(projectId);
        when(project.getSlug()).thenReturn("demo");
        when(project.getRepositoryUrl()).thenReturn("https://github.com/acme/demo.git");
        when(project.getDefaultBranch()).thenReturn("main");
        when(nodeService.get(nodeId)).thenReturn(oldNode);
        when(oldNode.getId()).thenReturn(nodeId);
        when(oldNode.getStatus()).thenReturn(ExecutionNodeStatus.ONLINE);
        when(runtimeRegistry.get(RuntimeType.CODEX)).thenReturn(runtime);
        when(runtime.startParameters("", "Implement features", AgentCapabilityProfile.IMPLEMENTER)).thenReturn(Map.of());

        service.recover(agentId);

        verify(scheduler, never()).select(any(), any(), any(), any());
        verify(nodeService).enqueue(eq(nodeId), eq(agentId), eq("START_AGENT"),
                eq("start-agent:" + agentId + ":g2"), any());
    }
}
