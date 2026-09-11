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
    private static final String OPERATIONAL_AGENT_NAME = "Operations";
    private static final String OPERATIONAL_RESPONSIBILITY = """
            You are the system-managed Operational Agent for this project.
            Own operational reasoning and coordination: inspect CI/CD state, release readiness, immutable image availability,
            migrations, health/readiness, deployment, backup, rollback, and post-operation verification.

            Prefer remote CI/CD workflows such as GitHub Actions for expensive build, test, image-build, and deployment work.
            Keep the Agenticform host clean: do not build production container images locally when an approved remote workflow exists.
            Coding/reviewer agents should hand off release candidates and operational requests to you through Agenticform messaging.
            Ask coding agents to make source-code changes instead of editing application code yourself.

            You do not own production credentials and must never attempt to bypass Agenticform policy.
            Use registered Agenticform runbooks for operational effects. A runbook request is itself policy-evaluated; do not
            separately request the same semantic action before requesting the runbook. Obey ALLOW / REQUIRE_HUMAN / DENY.
            After operations, inspect evidence and communicate concise results or blockers back to the requesting agent.
            """;

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

        ensureOperationalAgentInternal(project);

        WorkspaceMode mode = command.workspaceMode() == null ? WorkspaceMode.ISOLATED_WORKTREE : command.workspaceMode();
        String baseBranch = command.baseBranch() == null || command.baseBranch().isBlank()
                ? project.getDefaultBranch() : command.baseBranch();
        WorkspaceManager.WorkspaceAllocation workspace = workspaceManager.allocate(
                project, mode, command.name(), command.branch(), baseBranch);

        CodexGateway.ThreadHandle thread = codexGateway.startThread(
                workspace.workingDirectory().toString(), command.responsibility());

        AgentQueueMode queueMode = command.queueMode() == null ? AgentQueueMode.AUTO : command.queueMode();
        HumanControlMode humanControlMode = command.humanControlMode() == null
                ? HumanControlMode.ON_THE_LOOP : command.humanControlMode();
        AgentEntity agent = new AgentEntity(
                project.getId(), command.name(), command.responsibility(), thread.threadId(), mode,
                project.getRootDirectory(), workspace.workingDirectory().toString(), workspace.branch(),
                queueMode, humanControlMode, AgentRole.GENERAL, false);
        return repository.save(agent);
    }

    @Transactional
    public synchronized AgentEntity ensureOperationalAgent(UUID projectId) {
        ProjectEntity project = projectService.get(projectId);
        if (!project.isEnabled()) throw new IllegalStateException("Project is disabled");
        return ensureOperationalAgentInternal(project);
    }

    private AgentEntity ensureOperationalAgentInternal(ProjectEntity project) {
        return repository.findByProjectIdAndRole(project.getId(), AgentRole.OPERATIONAL)
                .orElseGet(() -> createOperationalAgent(project));
    }

    private AgentEntity createOperationalAgent(ProjectEntity project) {
        WorkspaceManager.WorkspaceAllocation workspace = workspaceManager.allocate(
                project, WorkspaceMode.SHARED_PROJECT, "operations", null, project.getDefaultBranch());
        CodexGateway.ThreadHandle thread = codexGateway.startThread(
                workspace.workingDirectory().toString(), OPERATIONAL_RESPONSIBILITY);
        AgentEntity agent = new AgentEntity(
                project.getId(), OPERATIONAL_AGENT_NAME, OPERATIONAL_RESPONSIBILITY, thread.threadId(),
                WorkspaceMode.SHARED_PROJECT, project.getRootDirectory(), workspace.workingDirectory().toString(),
                null, AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP, AgentRole.OPERATIONAL, true);
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
