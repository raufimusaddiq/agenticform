package com.agenticform.agent;

import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.runtime.RuntimeSession;
import com.agenticform.runtime.RuntimeType;
import com.agenticform.node.ExecutionNodeEntity;
import com.agenticform.node.ExecutionNodeScheduler;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.node.NodeTrustLevel;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectService;
import com.agenticform.project.ProjectSourceType;
import com.agenticform.workspace.WorkspaceManager;
import com.agenticform.workspace.WorkspaceMode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.UUID;

@Service
public class AgentService {
    private static final String OPERATIONAL_AGENT_NAME = "Operations";
    private static final String ORCHESTRATOR_AGENT_NAME = "Orchestrator";
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
            Before any deployment, call list_runbooks and check repositoryPlan: if it reports REPOSITORY_MANIFEST, sync and use
            that repository-declared runbook first (sync_repository_runbook, then request_operation). If it reports
            HUMAN_GATED_FALLBACK, do not invent deployment steps; call request_action with PRODUCTION_DEPLOY so a human performs
            the deployment and records evidence.
            After operations, inspect evidence and communicate concise results or blockers back to the requesting agent.
            """;
    private static final String ORCHESTRATOR_RESPONSIBILITY = """
            You are the system-managed Orchestrator for this project.
            Own the user-facing workflow: understand the assigned request, delegate architecture, matching implementers,
            tests, and review work,
            track dependencies, collect durable reports, and return one concise consolidated result.

            Use Agenticform list_agents, create_task, send_message, and report_task. Do not edit application code,
            deploy, or bypass policy. Delegate operational work through the Operational Agent.
            """;

    private final AgentRepository repository;
    private final ProjectService projectService;
    private final WorkspaceManager workspaceManager;
    private final AgentRuntimeRegistry runtimeRegistry;
    private final ExecutionNodeScheduler nodeScheduler;
    private final ExecutionNodeService nodeService;

    public AgentService(AgentRepository repository, ProjectService projectService,
                        WorkspaceManager workspaceManager, AgentRuntimeRegistry runtimeRegistry,
                        ExecutionNodeScheduler nodeScheduler, ExecutionNodeService nodeService) {
        this.repository = repository;
        this.projectService = projectService;
        this.workspaceManager = workspaceManager;
        this.runtimeRegistry = runtimeRegistry;
        this.nodeScheduler = nodeScheduler;
        this.nodeService = nodeService;
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
        if (!project.isEnabled()) throw new IllegalStateException("Project is disabled");
        ensureProjectAgentsInternal(project);
        AgentTemplate template = command.templateId() == null || command.templateId().isBlank()
                ? null : AgentTemplate.find(command.templateId());
        AgentCapabilityProfile profile = template == null
                ? command.capabilityProfile() == null ? AgentCapabilityProfile.IMPLEMENTER : command.capabilityProfile()
                : template.getCapabilityProfile();
        String name = command.name() == null || command.name().isBlank()
                ? template == null ? "Agent" : template.getDisplayName() : command.name();
        String responsibility = command.responsibility() == null || command.responsibility().isBlank()
                ? template == null ? "Inspect the repository, follow project policy, and report blockers." : template.getResponsibility()
                : command.responsibility();
        RuntimeType runtimeType = command.runtimeType();

        AgentEntity spawned;
        if (project.getSourceType() == ProjectSourceType.GIT) {
            spawned = createRemoteAgent(project, name, responsibility,
                    command.workspaceMode() == null ? WorkspaceMode.ISOLATED_WORKTREE : command.workspaceMode(),
                    command.baseBranch(), command.branch(),
                    command.queueMode() == null ? AgentQueueMode.AUTO : command.queueMode(),
                    command.humanControlMode() == null ? HumanControlMode.ON_THE_LOOP : command.humanControlMode(),
                    AgentRole.GENERAL, false, command.executionNodeId(), command.minimumTrust(), profile, runtimeType, command.runtimeProfileId());
        } else {
        if (command.executionNodeId() != null) {
            throw new IllegalArgumentException("LOCAL_PATH projects cannot be placed on remote execution nodes; register a GIT project source");
        }
        spawned = createLocalAgent(project, name, responsibility,
                command.workspaceMode() == null ? WorkspaceMode.ISOLATED_WORKTREE : command.workspaceMode(),
                command.baseBranch(), command.branch(),
                command.queueMode() == null ? AgentQueueMode.AUTO : command.queueMode(),
                command.humanControlMode() == null ? HumanControlMode.ON_THE_LOOP : command.humanControlMode(),
                AgentRole.GENERAL, false, profile, runtimeType, command.runtimeProfileId());
        }
        if (template != null) spawned.setSpecialty(template.getSpecialty());
        return repository.save(spawned);
    }

    @Transactional
    public AgentEntity ensureOperationalAgent(UUID projectId) {
        ProjectEntity project = projectService.get(projectId);
        if (!project.isEnabled()) throw new IllegalStateException("Project is disabled");
        return ensureProjectAgentsInternal(project);
    }

    private synchronized AgentEntity ensureProjectAgentsInternal(ProjectEntity project) {
        AgentEntity operational = ensureOperationalAgentInternal(project);
        ensureOrchestratorAgentInternal(project);
        return operational;
    }

    private synchronized AgentEntity ensureOperationalAgentInternal(ProjectEntity project) {
        return repository.findByProjectIdAndRole(project.getId(), AgentRole.OPERATIONAL)
                .orElseGet(() -> createOperationalAgent(project));
    }

    private AgentEntity createOperationalAgent(ProjectEntity project) {
        if (project.getSourceType() == ProjectSourceType.GIT) {
            return createRemoteAgent(project, OPERATIONAL_AGENT_NAME, OPERATIONAL_RESPONSIBILITY,
                    WorkspaceMode.SHARED_PROJECT, project.getDefaultBranch(), null,
                    AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP,
                    AgentRole.OPERATIONAL, true, null, NodeTrustLevel.STANDARD, AgentCapabilityProfile.OPS, RuntimeType.CODEX, null);
        }
        return createLocalAgent(project, OPERATIONAL_AGENT_NAME, OPERATIONAL_RESPONSIBILITY,
                WorkspaceMode.SHARED_PROJECT, project.getDefaultBranch(), null,
                AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP,
                AgentRole.OPERATIONAL, true, AgentCapabilityProfile.OPS, RuntimeType.CODEX, null);
    }

    private synchronized AgentEntity ensureOrchestratorAgentInternal(ProjectEntity project) {
        return repository.findByProjectIdAndRole(project.getId(), AgentRole.ORCHESTRATOR)
                .orElseGet(() -> createOrchestratorAgent(project));
    }

    private AgentEntity createOrchestratorAgent(ProjectEntity project) {
        if (project.getSourceType() == ProjectSourceType.GIT) {
            return createRemoteAgent(project, ORCHESTRATOR_AGENT_NAME, ORCHESTRATOR_RESPONSIBILITY,
                    WorkspaceMode.SHARED_PROJECT, project.getDefaultBranch(), null,
                    AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP,
                    AgentRole.ORCHESTRATOR, true, null, NodeTrustLevel.STANDARD,
                    AgentCapabilityProfile.ORCHESTRATOR, RuntimeType.CODEX, null);
        }
        return createLocalAgent(project, ORCHESTRATOR_AGENT_NAME, ORCHESTRATOR_RESPONSIBILITY,
                WorkspaceMode.SHARED_PROJECT, project.getDefaultBranch(), null,
                AgentQueueMode.AUTO, HumanControlMode.ON_THE_LOOP,
                AgentRole.ORCHESTRATOR, true, AgentCapabilityProfile.ORCHESTRATOR, RuntimeType.CODEX, null);
    }

    private AgentEntity createLocalAgent(ProjectEntity project, String name, String responsibility,
                                         WorkspaceMode mode, String requestedBaseBranch, String requestedBranch,
                                         AgentQueueMode queueMode, HumanControlMode humanControlMode,
                                         AgentRole role, boolean systemManaged,
                                         AgentCapabilityProfile capabilityProfile, RuntimeType runtimeType, String runtimeProfileId) {
        String baseBranch = requestedBaseBranch == null || requestedBaseBranch.isBlank()
                ? project.getDefaultBranch() : requestedBaseBranch;
        WorkspaceManager.WorkspaceAllocation workspace = workspaceManager.allocate(
                project, mode, name, requestedBranch, baseBranch);
        RuntimeSession session = runtimeRegistry.get(runtimeType).start(
                workspace.workingDirectory().toString(), responsibility, capabilityProfile);
        AgentEntity agent = new AgentEntity(
                project.getId(), name, responsibility, session.id(), mode,
                project.getRootDirectory(), workspace.workingDirectory().toString(), workspace.branch(),
                queueMode, humanControlMode, role, systemManaged, null, capabilityProfile);
        agent.setRuntimeType(runtimeType);
        agent.setRuntimeProfileId(runtimeProfileId);
        agent.setBaseBranch(baseBranch);
        return repository.save(agent);
    }

    private AgentEntity createRemoteAgent(ProjectEntity project, String name, String responsibility,
                                          WorkspaceMode mode, String requestedBaseBranch, String requestedBranch,
                                          AgentQueueMode queueMode, HumanControlMode humanControlMode,
                                         AgentRole role, boolean systemManaged,
                                         UUID preferredNodeId, NodeTrustLevel minimumTrust,
                                         AgentCapabilityProfile capabilityProfile, RuntimeType runtimeType, String runtimeProfileId) {
        ExecutionNodeEntity node = nodeScheduler.select(preferredNodeId,
                minimumTrust == null ? NodeTrustLevel.STANDARD : minimumTrust, Set.of("runtime:" + runtimeType.name(), "git"));
        String baseBranch = requestedBaseBranch == null || requestedBaseBranch.isBlank()
                ? project.getDefaultBranch() : requestedBaseBranch;
        AgentEntity agent = new AgentEntity(
                project.getId(), name, responsibility, null, mode,
                null, null, requestedBranch, queueMode, humanControlMode, role, systemManaged,
                node.getId(), capabilityProfile);
        agent.setRuntimeType(runtimeType);
        agent.setRuntimeProfileId(runtimeProfileId);
        agent.setBaseBranch(baseBranch);
        agent = repository.save(agent);

        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("agentId", agent.getId().toString());
            payload.put("projectId", project.getId().toString());
            payload.put("projectSlug", project.getSlug());
            payload.put("repositoryUrl", project.getRepositoryUrl());
            payload.put("defaultBranch", project.getDefaultBranch());
            payload.put("baseBranch", baseBranch);
            payload.put("workspaceMode", mode.name());
            payload.put("agentName", name);
            payload.put("requestedBranch", requestedBranch == null ? "" : requestedBranch);
            payload.put("runtimeType", runtimeType.name());
            if (agent.getRuntimeProfileId() != null) payload.put("runtimeProfileId", agent.getRuntimeProfileId());
            payload.put("runtimeStartParams", runtimeRegistry.get(runtimeType).startParameters("", responsibility, capabilityProfile));
            nodeService.enqueue(node.getId(), agent.getId(), "START_AGENT",
                    "start-agent:" + agent.getId() + ":g" + agent.getRuntimeGeneration(), payload);
            return agent;
        } catch (RuntimeException error) {
            agent.setStatus(AgentStatus.FAILED);
            repository.save(agent);
            throw error;
        }
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
        if (agent.getActiveTurnId() == null || agent.getActiveTurnId().isBlank()) return agent;

        if (agent.getExecutionNodeId() != null) {
            nodeService.enqueue(agent.getExecutionNodeId(), agent.getId(), "INTERRUPT_TURN",
                    "interrupt:" + agent.getId() + ":g" + agent.getRuntimeGeneration() + ":" + agent.getActiveTurnId(), Map.of(
                            "runtimeType", runtimeType(agent).name(),
                            "runtimeSessionId", runtimeSessionId(agent),
                            "turnId", agent.getActiveTurnId()));
            return agent;
        }
        try {
            runtimeRegistry.get(agent.getRuntimeType()).interrupt(new RuntimeSession(runtimeSessionId(agent)), agent.getActiveTurnId());
        } catch (RuntimeException interruptFailure) {
            agent.setStatus(AgentStatus.DISCONNECTED);
            return repository.save(agent);
        }
        return agent;
    }

    private String runtimeSessionId(AgentEntity agent) {
        return agent.getRuntimeSessionId();
    }

    private RuntimeType runtimeType(AgentEntity agent) {
        return agent.getRuntimeType();
    }

    public record SpawnAgent(UUID projectId, String name, String responsibility, WorkspaceMode workspaceMode,
                             String baseBranch, String branch, AgentQueueMode queueMode,
                             HumanControlMode humanControlMode, UUID executionNodeId,
                             NodeTrustLevel minimumTrust, AgentCapabilityProfile capabilityProfile,
                             RuntimeType runtimeType, String runtimeProfileId, String templateId) {}
}
