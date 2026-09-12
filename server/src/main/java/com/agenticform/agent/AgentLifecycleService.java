package com.agenticform.agent;

import com.agenticform.approval.HumanApprovalRepository;
import com.agenticform.approval.HumanApprovalStatus;
import com.agenticform.event.ControlPlaneEventBus;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectService;
import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.RuntimeSession;
import com.agenticform.runtime.RuntimeType;
import com.agenticform.task.TaskDependencyService;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import com.agenticform.task.TaskStatus;
import com.agenticform.workspace.WorkspaceLifecycleService;
import com.agenticform.workspace.WorkspaceMode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class AgentLifecycleService {
    private final AgentRepository agents;
    private final TaskRepository tasks;
    private final TaskDependencyService dependencies;
    private final HumanApprovalRepository approvals;
    private final ProjectService projects;
    private final AgentRuntime runtime;
    private final ExecutionNodeService nodes;
    private final WorkspaceLifecycleService workspaces;
    private final ControlPlaneEventBus events;

    public AgentLifecycleService(AgentRepository agents, TaskRepository tasks,
                                 TaskDependencyService dependencies,
                                 HumanApprovalRepository approvals,
                                 ProjectService projects, AgentRuntime runtime,
                                 ExecutionNodeService nodes,
                                 WorkspaceLifecycleService workspaces,
                                 ControlPlaneEventBus events) {
        this.agents = agents;
        this.tasks = tasks;
        this.dependencies = dependencies;
        this.approvals = approvals;
        this.projects = projects;
        this.runtime = runtime;
        this.nodes = nodes;
        this.workspaces = workspaces;
        this.events = events;
    }

    @Transactional
    public AgentEntity stop(UUID agentId) {
        AgentEntity agent = agent(agentId);
        if (agent.isSystemManaged()) {
            throw new IllegalStateException("System-managed agents cannot be stopped independently of their project");
        }
        if (agent.getStatus() == AgentStatus.STOPPED || agent.getStatus() == AgentStatus.STOPPING) {
            return agent;
        }
        if (approvals.existsByAgentIdAndStatus(agentId, HumanApprovalStatus.PENDING)) {
            throw new IllegalStateException("Resolve or cancel the pending human approval before stopping this agent");
        }

        agent.setQueueMode(AgentQueueMode.PAUSED);
        cancelNonTerminalTasks(agentId);

        if (agent.getExecutionNodeId() == null) {
            return stopLocal(agent);
        }
        return stopRemote(agent);
    }

    private AgentEntity stopLocal(AgentEntity agent) {
        if (hasActiveTurn(agent)) {
            try {
                runtime.interrupt(new RuntimeSession(runtimeSessionId(agent)), agent.getActiveTurnId());
            } catch (RuntimeException error) {
                agent.setStatus(AgentStatus.DISCONNECTED);
                agents.save(agent);
                events.publish("agent.stop_failed", agent.getProjectId(), agent.getId());
                throw new IllegalStateException("Unable to interrupt active local Codex turn before stop", error);
            }
        }
        agent.setActiveTaskId(null);
        agent.setActiveTurnId(null);
        agents.save(agent);

        // Cleanup is deliberately opportunistic. Dirty or unmerged work is retained, while the
        // runtime still stops deterministically.
        if (agent.getWorkspaceMode() == WorkspaceMode.ISOLATED_WORKTREE) {
            WorkspaceLifecycleService.Inspection inspection = workspaces.inspect(agent.getId());
            if (inspection.eligible()) {
                workspaces.cleanup(agent.getId(), "Agent stop lifecycle");
                AgentEntity stopped = agent(agent.getId());
                events.publish("agent.stopped", stopped.getProjectId(), stopped.getId());
                return stopped;
            }
        }
        agent.setStatus(AgentStatus.STOPPED);
        agents.save(agent);
        events.publish("agent.stopped", agent.getProjectId(), agent.getId());
        return agent;
    }

    private AgentEntity stopRemote(AgentEntity agent) {
        ProjectEntity project = projects.get(agent.getProjectId());
        boolean activeTurn = hasActiveTurn(agent);
        boolean isolated = agent.getWorkspaceMode() == WorkspaceMode.ISOLATED_WORKTREE;

        if (activeTurn) {
            Map<String, Object> interrupt = new LinkedHashMap<>();
            interrupt.put("threadId", agent.getCodexThreadId());
            interrupt.put("runtimeType", RuntimeType.CODEX.name());
            interrupt.put("turnId", agent.getActiveTurnId());
            interrupt.put("stopLifecycle", true);
            interrupt.put("finalizeStop", !isolated);
            interrupt.put("cleanupAfterInterrupt", isolated);
            interrupt.put("defaultBranch", project.getDefaultBranch());
            nodes.enqueue(agent.getExecutionNodeId(), agent.getId(), "INTERRUPT_TURN",
                    "stop-interrupt:" + agent.getId() + ":g" + agent.getRuntimeGeneration(), interrupt);
        } else if (isolated) {
            enqueueStopCleanup(agent, project.getDefaultBranch());
        }

        agent.setActiveTaskId(null);
        agent.setActiveTurnId(null);
        if (!activeTurn && !isolated) {
            agent.setStatus(AgentStatus.STOPPED);
            agents.save(agent);
            events.publish("agent.stopped", agent.getProjectId(), agent.getId());
            return agent;
        }
        agent.setStatus(AgentStatus.STOPPING);
        agents.save(agent);
        events.publish("agent.stopping", agent.getProjectId(), agent.getId());
        return agent;
    }

    private void enqueueStopCleanup(AgentEntity agent, String defaultBranch) {
        Map<String, Object> cleanup = new LinkedHashMap<>();
        cleanup.put("threadId", agent.getCodexThreadId() == null ? "" : agent.getCodexThreadId());
        cleanup.put("runtimeType", RuntimeType.CODEX.name());
        cleanup.put("defaultBranch", defaultBranch);
        cleanup.put("stopLifecycle", true);
        nodes.enqueue(agent.getExecutionNodeId(), agent.getId(), "CLEANUP_WORKSPACE",
                "stop-cleanup:" + agent.getId() + ":g" + agent.getRuntimeGeneration(), cleanup);
    }

    private void cancelNonTerminalTasks(UUID agentId) {
        for (TaskEntity task : tasks.findAllByAssignedAgentIdOrderByCreatedAtAsc(agentId)) {
            if (terminal(task.getStatus())) continue;
            task.setStatus(TaskStatus.CANCELLED);
            task.setLastError("Cancelled because assigned agent was stopped");
            tasks.save(task);
            dependencies.reconcileDependents(task.getId());
        }
    }

    private boolean terminal(TaskStatus status) {
        return status == TaskStatus.COMPLETED || status == TaskStatus.FAILED || status == TaskStatus.CANCELLED;
    }

    private boolean hasActiveTurn(AgentEntity agent) {
        return agent.getActiveTurnId() != null && !agent.getActiveTurnId().isBlank()
                && runtimeSessionId(agent) != null && !runtimeSessionId(agent).isBlank();
    }

    private String runtimeSessionId(AgentEntity agent) {
        String sessionId = agent.getRuntimeSessionId();
        return sessionId == null || sessionId.isBlank() ? agent.getCodexThreadId() : sessionId;
    }

    private AgentEntity agent(UUID id) {
        return agents.findById(id).orElseThrow(() -> new NoSuchElementException("Agent not found: " + id));
    }
}
