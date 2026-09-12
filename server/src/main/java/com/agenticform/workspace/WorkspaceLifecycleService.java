package com.agenticform.workspace;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.config.AgenticformProperties;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectRepository;
import com.agenticform.task.TaskRepository;
import com.agenticform.task.TaskStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class WorkspaceLifecycleService {
    public record Inspection(UUID agentId, boolean eligible, String reason, long estimatedBytes) {}

    private static final List<TaskStatus> ACTIVE_TASK_STATUSES = List.of(
            TaskStatus.QUEUED, TaskStatus.READY, TaskStatus.WAITING_DEPENDENCY,
            TaskStatus.DISPATCHING, TaskStatus.DISPATCHED, TaskStatus.RUNNING,
            TaskStatus.BLOCKED, TaskStatus.WAITING_APPROVAL, TaskStatus.PAUSED);

    private final AgentRepository agentRepository;
    private final ProjectRepository projectRepository;
    private final TaskRepository taskRepository;
    private final WorkspaceCleanupRecordRepository cleanupRepository;
    private final WorkspaceManager workspaceManager;
    private final AgenticformProperties properties;

    public WorkspaceLifecycleService(AgentRepository agentRepository,
                                     ProjectRepository projectRepository,
                                     TaskRepository taskRepository,
                                     WorkspaceCleanupRecordRepository cleanupRepository,
                                     WorkspaceManager workspaceManager,
                                     AgenticformProperties properties) {
        this.agentRepository = agentRepository;
        this.projectRepository = projectRepository;
        this.taskRepository = taskRepository;
        this.cleanupRepository = cleanupRepository;
        this.workspaceManager = workspaceManager;
        this.properties = properties;
    }

    public Inspection inspect(UUID agentId) {
        AgentEntity agent = agent(agentId);
        String blocker = lifecycleBlocker(agent);
        if (blocker != null) return new Inspection(agentId, false, blocker, 0);
        ProjectEntity project = project(agent.getProjectId());
        WorkspaceManager.CleanupInspection inspection = workspaceManager.inspectForCleanup(
                project, agent.getWorkingDirectory(), agent.getBranch());
        return new Inspection(agentId, inspection.eligible(), inspection.reason(), inspection.estimatedBytes());
    }

    public synchronized WorkspaceCleanupRecordEntity cleanup(UUID agentId, String reason) {
        AgentEntity agent = agent(agentId);
        Inspection inspection = inspect(agentId);
        if (!inspection.eligible()) throw new IllegalStateException("Workspace cleanup refused: " + inspection.reason());
        ProjectEntity project = project(agent.getProjectId());
        WorkspaceManager.CleanupResult result = workspaceManager.removeMergedWorktree(
                project, agent.getWorkingDirectory(), agent.getBranch());
        agent.setStatus(AgentStatus.STOPPED);
        agent.setActiveTaskId(null);
        agent.setActiveTurnId(null);
        agentRepository.save(agent);
        return cleanupRepository.save(new WorkspaceCleanupRecordEntity(
                project.getId(), agent.getId(), agent.getWorkingDirectory(), agent.getBranch(), "CLEANED",
                reason == null || reason.isBlank() ? result.reason() : reason.trim() + "; " + result.reason(),
                result.freedBytes()));
    }

    public List<WorkspaceCleanupRecordEntity> history(UUID projectId) {
        return projectId == null ? cleanupRepository.findAll()
                : cleanupRepository.findAllByProjectIdOrderByCreatedAtDesc(projectId);
    }

    @Scheduled(fixedDelayString = "${agenticform.workspace.cleanup-delay-ms:3600000}")
    public void cleanupEligibleWorktrees() {
        Instant cutoff = Instant.now().minus(properties.getWorkspace().getCleanupRetention());
        for (AgentEntity agent : agentRepository.findAll()) {
            if (agent.getUpdatedAt() == null || agent.getUpdatedAt().isAfter(cutoff)) continue;
            Inspection inspection = inspect(agent.getId());
            if (!inspection.eligible()) continue;
            try {
                cleanup(agent.getId(), "Automatic cleanup after retention period");
            } catch (RuntimeException ignored) {
                // Cleanup is opportunistic and fail-closed; a later pass can re-inspect.
            }
        }
    }

    private String lifecycleBlocker(AgentEntity agent) {
        if (agent.isSystemManaged()) return "System-managed agents are never workspace-GC targets";
        if (agent.getWorkspaceMode() != WorkspaceMode.ISOLATED_WORKTREE) return "Agent does not own an isolated worktree";
        if (agent.getActiveTaskId() != null || agent.getActiveTurnId() != null) return "Agent still has active execution state";
        if (!List.of(AgentStatus.IDLE, AgentStatus.FAILED, AgentStatus.DISCONNECTED, AgentStatus.STOPPED).contains(agent.getStatus())) {
            return "Agent status is not terminal/idle enough for cleanup: " + agent.getStatus();
        }
        if (taskRepository.existsByAssignedAgentIdAndStatusIn(agent.getId(), ACTIVE_TASK_STATUSES)) {
            return "Agent still has non-terminal tasks";
        }
        return null;
    }

    private AgentEntity agent(UUID id) {
        return agentRepository.findById(id).orElseThrow(() -> new NoSuchElementException("Agent not found: " + id));
    }

    private ProjectEntity project(UUID id) {
        return projectRepository.findById(id).orElseThrow(() -> new NoSuchElementException("Project not found: " + id));
    }
}
