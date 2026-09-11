package com.agenticform.agent;

import com.agenticform.codex.CodexGateway;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectService;
import com.agenticform.workspace.WorkspaceManager;
import com.agenticform.workspace.WorkspaceMode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class AgentService {
    private final AgentRepository repository;
    private final ProjectService projectService;
    private final WorkspaceManager workspaceManager;
    private final CodexGateway codexGateway;

    public AgentService(AgentRepository repository, ProjectService projectService,
                        WorkspaceManager workspaceManager, CodexGateway codexGateway) {
        this.repository = repository;
        this.projectService = projectService;
        this.workspaceManager = workspaceManager;
        this.codexGateway = codexGateway;
    }

    public List<AgentEntity> list(UUID projectId) {
        return projectId == null ? repository.findAll() : repository.findAllByProjectId(projectId);
    }

    public AgentEntity get(UUID id) {
        return repository.findById(id).orElseThrow(() -> new NoSuchElementException("Agent not found: " + id));
    }

    @Transactional
    public AgentEntity spawn(SpawnAgent command) {
        ProjectEntity project = projectService.get(command.projectId());
        if (!project.isEnabled()) {
            throw new IllegalStateException("Project is disabled");
        }
        WorkspaceMode mode = command.workspaceMode() == null ? WorkspaceMode.ISOLATED_WORKTREE : command.workspaceMode();
        String baseBranch = command.baseBranch() == null || command.baseBranch().isBlank()
                ? project.getDefaultBranch() : command.baseBranch();
        WorkspaceManager.WorkspaceAllocation workspace = workspaceManager.allocate(
                project, mode, command.name(), command.branch(), baseBranch);

        CodexGateway.ThreadHandle thread = codexGateway.startThread(
                workspace.workingDirectory().toString(), command.responsibility());

        AgentQueueMode queueMode = command.queueMode() == null ? AgentQueueMode.AUTO : command.queueMode();
        HumanControlMode humanControlMode = command.humanControlMode() == null
                ? HumanControlMode.IN_THE_LOOP : command.humanControlMode();
        AgentEntity agent = new AgentEntity(
                project.getId(), command.name(), command.responsibility(), thread.threadId(), mode,
                project.getRootDirectory(), workspace.workingDirectory().toString(), workspace.branch(),
                queueMode, humanControlMode);
        return repository.save(agent);
    }

    @Transactional
    public AgentEntity updateHumanControlMode(UUID agentId, HumanControlMode mode) {
        AgentEntity agent = get(agentId);
        agent.setHumanControlMode(mode);
        return repository.save(agent);
    }

    @Transactional
    public AgentEntity updateQueueMode(UUID agentId, AgentQueueMode mode) {
        AgentEntity agent = get(agentId);
        agent.setQueueMode(mode);
        return repository.save(agent);
    }

    @Transactional
    public AgentEntity intervene(UUID agentId) {
        AgentEntity agent = get(agentId);
        agent.setQueueMode(AgentQueueMode.PAUSED);
        repository.save(agent);

        if (agent.getActiveTurnId() != null && !agent.getActiveTurnId().isBlank()) {
            try {
                codexGateway.interruptTurn(agent.getCodexThreadId(), agent.getActiveTurnId());
            } catch (RuntimeException interruptFailure) {
                // Pausing future work is authoritative even if the active Codex connection is gone.
                // Mark the transport state so the operator can see that the interrupt itself was not confirmed.
                agent.setStatus(AgentStatus.DISCONNECTED);
                return repository.save(agent);
            }
        }
        return agent;
    }

    public record SpawnAgent(UUID projectId, String name, String responsibility, WorkspaceMode workspaceMode,
                             String baseBranch, String branch, AgentQueueMode queueMode,
                             HumanControlMode humanControlMode) {}
}
