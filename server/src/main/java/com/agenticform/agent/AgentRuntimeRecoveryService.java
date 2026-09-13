package com.agenticform.agent;

import com.agenticform.approval.HumanApprovalRepository;
import com.agenticform.approval.HumanApprovalStatus;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.runtime.RuntimeType;
import com.agenticform.node.ExecutionNodeEntity;
import com.agenticform.node.ExecutionNodeScheduler;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.node.ExecutionNodeStatus;
import com.agenticform.node.NodeTrustLevel;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectService;
import com.agenticform.project.ProjectSourceType;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import com.agenticform.task.TaskStatus;
import com.agenticform.workspace.WorkspaceMode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.UUID;

@Service
public class AgentRuntimeRecoveryService {
    private final AgentRepository agents;
    private final ProjectService projects;
    private final TaskRepository tasks;
    private final HumanApprovalRepository approvals;
    private final ExecutionNodeScheduler scheduler;
    private final ExecutionNodeService nodeService;
    private final AgentRuntimeRegistry runtimeRegistry;

    public AgentRuntimeRecoveryService(AgentRepository agents,
                                       ProjectService projects,
                                       TaskRepository tasks,
                                       HumanApprovalRepository approvals,
                                       ExecutionNodeScheduler scheduler,
                                       ExecutionNodeService nodeService,
                                       AgentRuntimeRegistry runtimeRegistry) {
        this.agents = agents;
        this.projects = projects;
        this.tasks = tasks;
        this.approvals = approvals;
        this.scheduler = scheduler;
        this.nodeService = nodeService;
        this.runtimeRegistry = runtimeRegistry;
    }

    @Transactional
    public AgentEntity recover(UUID agentId) {
        AgentEntity agent = agents.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        if (agent.getExecutionNodeId() == null) {
            throw new IllegalStateException("Local Agenticform runtimes are not rehydrated through the execution fabric");
        }
        if (agent.getStatus() != AgentStatus.DISCONNECTED && agent.getStatus() != AgentStatus.FAILED) {
            throw new IllegalStateException("Agent runtime is not recoverable from status " + agent.getStatus());
        }
        if (approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)) {
            throw new IllegalStateException("Resolve or cancel the pending human approval before moving this runtime");
        }

        ProjectEntity project = projects.get(agent.getProjectId());
        if (project.getSourceType() != ProjectSourceType.GIT) {
            throw new IllegalStateException("Only GIT-backed agents can be rehydrated on another execution node");
        }
        UUID oldNodeId = agent.getExecutionNodeId();
        ExecutionNodeEntity oldNode = nodeService.get(oldNodeId);
        if (oldNode.getStatus() == ExecutionNodeStatus.ONLINE) {
            throw new IllegalStateException("Current execution node is online; reconcile it instead of creating a second runtime");
        }

        RuntimeType runtimeType = agent.getRuntimeType();
        ExecutionNodeEntity replacement = scheduler.select(null, NodeTrustLevel.STANDARD,
                        Set.of("runtime:" + runtimeType.name(), "git"), Set.of(oldNodeId));
        long nextGeneration = agent.getRuntimeGeneration() + 1;
        String recoveryBranch = "recovery/" + safe(agent.getName()) + "-"
                + agent.getId().toString().substring(0, 8) + "-g" + nextGeneration;
        String previousBranch = agent.getBranch();
        UUID activeTaskId = agent.getActiveTaskId();
        TaskEntity activeTask = activeTaskId == null ? null : tasks.findById(activeTaskId).orElse(null);
        if (activeTask != null && terminal(activeTask.getStatus())) activeTask = null;

        long generation = agent.reassignRuntime(replacement.getId(), recoveryBranch);
        agents.save(agent);

        if (activeTask != null) {
            activeTask.setStatus(TaskStatus.BLOCKED);
            activeTask.setQueuedSubmissionId(null);
            activeTask.setTurnId(null);
            activeTask.setLastError("Execution node was lost; task will resume after runtime rehydration");
            tasks.save(activeTask);
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("agentId", agent.getId().toString());
        payload.put("runtimeType", runtimeType.name());
        payload.put("projectId", project.getId().toString());
        payload.put("projectSlug", project.getSlug());
        payload.put("repositoryUrl", project.getRepositoryUrl());
        payload.put("defaultBranch", project.getDefaultBranch());
        payload.put("baseBranch", previousBranch == null || previousBranch.isBlank()
                ? project.getDefaultBranch() : previousBranch);
        payload.put("workspaceMode", agent.getWorkspaceMode().name());
        payload.put("agentName", agent.getName());
        payload.put("requestedBranch", recoveryBranch);
        payload.put("recovery", true);
        payload.put("previousNodeId", oldNodeId.toString());
        if (activeTask != null) payload.put("recoveryTaskId", activeTask.getId().toString());
        payload.put("runtimeStartParams", runtimeRegistry.get(runtimeType).startParameters("", agent.getResponsibility(), agent.getCapabilityProfile()));
        nodeService.enqueue(replacement.getId(), agent.getId(), "START_AGENT",
                "start-agent:" + agent.getId() + ":g" + generation, payload);
        return agent;
    }

    @Transactional
    public AgentEntity restart(UUID agentId) {
        AgentEntity agent = agents.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        if (agent.getExecutionNodeId() == null) throw new IllegalStateException("Only remote runtimes can be restarted");
        if (agent.getActiveTaskId() != null || agent.getActiveTurnId() != null) {
            throw new IllegalStateException("Restart requires an idle agent with no active task or turn");
        }
        if (approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)) {
            throw new IllegalStateException("Resolve or cancel the pending human approval before restarting this runtime");
        }

        ProjectEntity project = projects.get(agent.getProjectId());
        long generation = agent.getRuntimeGeneration() + 1;
        String branch = "restart/" + safe(agent.getName()) + "-" + agent.getId().toString().substring(0, 8) + "-g" + generation;
        UUID nodeId = agent.getExecutionNodeId();
        agent.reassignRuntime(nodeId, branch);
        agents.save(agent);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("agentId", agent.getId().toString());
        payload.put("runtimeType", agent.getRuntimeType().name());
        payload.put("projectId", project.getId().toString());
        payload.put("projectSlug", project.getSlug());
        payload.put("repositoryUrl", project.getRepositoryUrl());
        payload.put("defaultBranch", project.getDefaultBranch());
        payload.put("baseBranch", project.getDefaultBranch());
        payload.put("workspaceMode", agent.getWorkspaceMode().name());
        payload.put("agentName", agent.getName());
        payload.put("requestedBranch", branch);
        payload.put("runtimeStartParams", runtimeRegistry.get(agent.getRuntimeType()).startParameters("", agent.getResponsibility(), agent.getCapabilityProfile()));
        nodeService.enqueue(nodeId, agent.getId(), "START_AGENT",
                "restart-agent:" + agent.getId() + ":g" + generation, payload);
        return agent;
    }

    @Transactional
    public AgentEntity cleanup(UUID agentId) {
        AgentEntity agent = agents.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        if (agent.getExecutionNodeId() == null) {
            throw new IllegalStateException("Use local workspace cleanup for local Agenticform agents");
        }
        if (agent.getWorkspaceMode() != WorkspaceMode.ISOLATED_WORKTREE) {
            throw new IllegalStateException("Shared project runtimes are never automatically cleaned");
        }
        if (agent.getActiveTaskId() != null || agent.getActiveTurnId() != null) {
            throw new IllegalStateException("Active agent runtime cannot be cleaned");
        }
        if (agent.getStatus() != AgentStatus.IDLE && agent.getStatus() != AgentStatus.FAILED) {
            throw new IllegalStateException("Runtime cleanup requires an idle or failed agent");
        }
        if (approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)) {
            throw new IllegalStateException("Pending human approval prevents runtime cleanup");
        }
        ExecutionNodeEntity node = nodeService.get(agent.getExecutionNodeId());
        if (node.getStatus() != ExecutionNodeStatus.ONLINE) {
            throw new IllegalStateException("Execution node must be online for deterministic cleanup");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runtimeType", runtimeType(agent).name());
        if (runtimeSessionId(agent) != null && !runtimeSessionId(agent).isBlank()) {
            payload.put("runtimeSessionId", runtimeSessionId(agent));
        }
        nodeService.enqueue(node.getId(), agent.getId(), "CLEANUP_WORKSPACE",
                "cleanup-runtime:" + agent.getId() + ":g" + agent.getRuntimeGeneration(), payload);
        agent.setQueueMode(AgentQueueMode.PAUSED);
        agent.setStatus(AgentStatus.BLOCKED);
        return agents.save(agent);
    }

    private boolean terminal(TaskStatus status) {
        return status == TaskStatus.COMPLETED || status == TaskStatus.CANCELLED || status == TaskStatus.FAILED;
    }

    private String safe(String value) {
        String normalized = value == null ? "agent" : value.toLowerCase().replaceAll("[^a-z0-9]+", "-");
        normalized = normalized.replaceAll("^-+|-+$", "");
        return normalized.isBlank() ? "agent" : normalized;
    }

    private String runtimeSessionId(AgentEntity agent) {
        return agent.getRuntimeSessionId();
    }

    private RuntimeType runtimeType(AgentEntity agent) {
        return agent.getRuntimeType();
    }
}
