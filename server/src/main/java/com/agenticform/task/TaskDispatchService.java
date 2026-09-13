package com.agenticform.task;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentCapabilityProfile;
import com.agenticform.agent.AgentQueueMode;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentRole;
import com.agenticform.agent.AgentStatus;
import com.agenticform.node.ExecutionNodeService;
import com.agenticform.runtime.AgentRuntime;
import com.agenticform.runtime.AgentRuntimeRegistry;
import com.agenticform.runtime.RuntimeDispatchReceipt;
import com.agenticform.runtime.RuntimeSession;
import com.agenticform.runtime.RuntimeType;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class TaskDispatchService {
    public static final String COMPLETION_CONTRACT = "\n\nMANDATORY COMPLETION CONTRACT: Before ending this task, call agenticform.report_task with outcome, changed files, validation, blockers, and follow-up. Orchestrators must delegate required work with agenticform.create_task, collect durable reports, then submit the consolidated report. Never finish with analysis only.";
    private final TaskRepository taskRepository;
    private final AgentRepository agentRepository;
    private final AgentRuntimeRegistry runtimeRegistry;
    private final ExecutionNodeService nodeService;
    private final TaskDependencyService dependencyService;

    public TaskDispatchService(TaskRepository taskRepository, AgentRepository agentRepository,
                               AgentRuntimeRegistry runtimeRegistry, ExecutionNodeService nodeService,
                               TaskDependencyService dependencyService) {
        this.taskRepository = taskRepository;
        this.agentRepository = agentRepository;
        this.runtimeRegistry = runtimeRegistry;
        this.nodeService = nodeService;
        this.dependencyService = dependencyService;
    }

    public List<TaskEntity> list(UUID projectId) {
        return projectId == null ? taskRepository.findAll() : taskRepository.findAllByProjectIdOrderByCreatedAtDesc(projectId);
    }

    @Transactional
    public TaskEntity create(UUID agentId, String title, String prompt, int priority) {
        return create(agentId, title, prompt, priority, List.of(), null);
    }

    @Transactional
    public TaskEntity create(UUID agentId, String title, String prompt, int priority,
                             List<TaskDependencyService.DependencyRequest> dependencies) {
        return create(agentId, title, prompt, priority, dependencies, null);
    }

    @Transactional
    public TaskEntity create(UUID agentId, String title, String prompt, int priority,
                             List<TaskDependencyService.DependencyRequest> dependencies, UUID parentTaskId) {
        return create(agentId, title, prompt, priority, dependencies, parentTaskId, null);
    }

    @Transactional
    public TaskEntity create(UUID agentId, String title, String prompt, int priority,
                             List<TaskDependencyService.DependencyRequest> dependencies, UUID parentTaskId,
                             TaskKind requestedKind) {
        AgentEntity agent = agentRepository.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        if (agent.getRole() == AgentRole.OPERATIONAL) {
            throw new IllegalArgumentException("Operational Agent does not accept normal tasks; use agent-to-agent operational handoff");
        }
        if (parentTaskId != null) {
            TaskEntity parent = taskRepository.findById(parentTaskId)
                    .orElseThrow(() -> new NoSuchElementException("Parent task not found: " + parentTaskId));
            if (!parent.getProjectId().equals(agent.getProjectId())) throw new IllegalArgumentException("Parent task belongs to another project");
            prompt = TaskContextCompactor.inherit(parent, prompt);
        }
        TaskKind kind = requestedKind == null ? kindFor(agent) : requestedKind;
        UUID workflowId = parentTaskId == null ? null : taskRepository.findById(parentTaskId)
                .map(TaskEntity::getWorkflowId).orElseThrow(() -> new NoSuchElementException("Parent task not found: " + parentTaskId));
        if (kind == TaskKind.OPERATIONS || agent.getRole() == AgentRole.OPERATIONAL) {
            throw new IllegalArgumentException("Operational work must use the operational handoff");
        }
        if (kind == TaskKind.IMPLEMENTATION && !agent.getCapabilityProfile().allows(AgentCapabilityProfile.Capability.WRITE)) {
            throw new IllegalArgumentException("Implementation tasks require an agent with WRITE capability");
        }
        if (kind == TaskKind.REVIEW && !agent.getCapabilityProfile().allows(AgentCapabilityProfile.Capability.REVIEW)) {
            throw new IllegalArgumentException("Review tasks require an agent with REVIEW capability");
        }
        TaskEntity existing = taskRepository.findAllByProjectIdOrderByCreatedAtDesc(agent.getProjectId()).stream()
                .filter(candidate -> candidate.getAssignedAgentId().equals(agentId))
                .filter(candidate -> java.util.Objects.equals(candidate.getParentTaskId(), parentTaskId))
                .filter(candidate -> candidate.getKind() == kind)
                .filter(candidate -> candidate.getTitle().trim().equalsIgnoreCase(title.trim()))
                .filter(candidate -> candidate.getStatus() == TaskStatus.READY
                        || candidate.getStatus() == TaskStatus.WAITING_DEPENDENCY
                        || candidate.getStatus() == TaskStatus.DISPATCHED
                        || candidate.getStatus() == TaskStatus.RUNNING
                        || candidate.getStatus() == TaskStatus.WAITING_APPROVAL)
                .findFirst().orElse(null);
        if (existing != null) return existing;
        TaskEntity task = taskRepository.save(new TaskEntity(agent.getProjectId(), agentId, title, prompt, priority, parentTaskId, kind, workflowId));
        if (dependencies != null) {
            for (TaskDependencyService.DependencyRequest dependency : dependencies) {
                if (dependency == null || dependency.taskId() == null) {
                    throw new IllegalArgumentException("Dependency task id is required");
                }
                dependencyService.add(task.getId(), dependency.taskId(), dependency.type());
            }
        }
        return taskRepository.findById(task.getId()).orElse(task);
    }

    @Transactional
    public TaskEntity report(UUID agentId, UUID taskId, String report) {
        AgentEntity agent = agentRepository.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        TaskEntity task = taskRepository.findById(taskId)
                .orElseThrow(() -> new NoSuchElementException("Task not found: " + taskId));
        if (!task.getAssignedAgentId().equals(agentId) || !task.getProjectId().equals(agent.getProjectId())) {
            throw new IllegalArgumentException("Agent may only report its own project task");
        }
        if (report == null || report.isBlank()) throw new IllegalArgumentException("Task report is required");
        if (report.length() > 20000) throw new IllegalArgumentException("Task report is too long");
        if (agent.getRole() == AgentRole.ORCHESTRATOR) {
            List<TaskEntity> descendants = descendants(taskId);
            List<TaskEntity> unfinished = descendants.stream()
                    .filter(child -> (child.getStatus() != TaskStatus.COMPLETED && child.getStatus() != TaskStatus.CANCELLED)
                            || (child.getReport() != null && child.getReport().startsWith("BLOCKER:")))
                    .toList();
            if (!unfinished.isEmpty()) {
                throw new IllegalStateException("Orchestrator cannot complete while delegated tasks remain unresolved: "
                        + unfinished.stream().map(child -> child.getId() + "=" + child.getStatus()).toList());
            }
            if (requiresImplementation(task) && descendants.stream().noneMatch(this::hasImplementationEvidence)) {
                throw new IllegalStateException("Orchestrator cannot complete an implementation workflow without an Implementer child report containing changed-file evidence");
            }
            if (requiresImplementation(task) && descendants.stream().noneMatch(this::hasArchitectureEvidence)) {
                throw new IllegalStateException("Orchestrator cannot complete an implementation workflow without an architecture report");
            }
            if (requiresImplementation(task) && descendants.stream().noneMatch(this::hasReviewEvidence)) {
                throw new IllegalStateException("Orchestrator cannot complete an implementation workflow without a completed review report");
            }
        }
        task.setReport(report.trim());
        return taskRepository.save(task);
    }

    @Transactional
    public TaskEntity block(UUID agentId, String reason) {
        AgentEntity agent = agentRepository.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        if (agent.getActiveTaskId() == null) throw new IllegalStateException("Agent has no active task");
        TaskEntity task = taskRepository.findById(agent.getActiveTaskId())
                .orElseThrow(() -> new NoSuchElementException("Active task not found: " + agent.getActiveTaskId()));
        if (!task.getAssignedAgentId().equals(agentId)) throw new IllegalArgumentException("Agent may only block its own task");
        task.setStatus(TaskStatus.BLOCKED);
        task.setLastError(reason);
        task.setReport("BLOCKER: " + reason);
        return taskRepository.save(task);
    }

    private List<TaskEntity> descendants(UUID parentTaskId) {
        List<TaskEntity> result = new java.util.ArrayList<>();
        for (TaskEntity child : taskRepository.findAllByParentTaskIdOrderByCreatedAtAsc(parentTaskId)) {
            result.add(child);
            result.addAll(descendants(child.getId()));
        }
        return result;
    }

    private boolean requiresImplementation(TaskEntity task) {
        if (task.getKind() == TaskKind.ORCHESTRATION) return true;
        String prompt = task.getPrompt() == null ? "" : task.getPrompt().toLowerCase(java.util.Locale.ROOT);
        if (prompt.contains("read-only") || prompt.contains("read only")
                || prompt.contains("review-only") || prompt.contains("review only")
                || prompt.contains("design-only") || prompt.contains("design only")) return false;
        return prompt.contains("product requirements") || prompt.contains("prd")
                || prompt.contains("implement") || prompt.contains("build")
                || prompt.contains("feature") || prompt.contains("bug fix")
                || prompt.contains("sprint") || prompt.contains("code change");
    }

    private TaskKind kindFor(AgentEntity agent) {
        return switch (agent.getCapabilityProfile()) {
            case ORCHESTRATOR -> TaskKind.ORCHESTRATION;
            case ARCHITECT -> TaskKind.ARCHITECTURE;
            case REVIEWER -> TaskKind.REVIEW;
            case OPS -> TaskKind.OPERATIONS;
            case IMPLEMENTER -> TaskKind.IMPLEMENTATION;
        };
    }

    private boolean hasImplementationEvidence(TaskEntity task) {
        AgentEntity childAgent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
        String report = task.getReport() == null ? "" : task.getReport().toLowerCase(java.util.Locale.ROOT);
        return childAgent != null
                && childAgent.getCapabilityProfile() == AgentCapabilityProfile.IMPLEMENTER
                && !report.contains("changed files: none")
                && (report.contains("changed files") || report.contains("implemented"));
    }

    private boolean hasReviewEvidence(TaskEntity task) {
        AgentEntity childAgent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
        String report = task.getReport() == null ? "" : task.getReport().toLowerCase(java.util.Locale.ROOT);
        return task.getKind() == TaskKind.REVIEW
                && childAgent != null
                && childAgent.getCapabilityProfile() == AgentCapabilityProfile.REVIEWER
                && !report.contains("fail")
                && (report.contains("review") || report.contains("validation") || report.contains("approved"));
    }

    private boolean hasArchitectureEvidence(TaskEntity task) {
        AgentEntity childAgent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
        String report = task.getReport() == null ? "" : task.getReport().toLowerCase(java.util.Locale.ROOT);
        return task.getKind() == TaskKind.ARCHITECTURE
                && childAgent != null
                && childAgent.getCapabilityProfile() == AgentCapabilityProfile.ARCHITECT
                && !report.contains("blocker")
                && (report.contains("architecture") || report.contains("design") || report.contains("implementation brief"));
    }

    public synchronized void dispatchReadyTasks() {
        for (TaskEntity task : taskRepository.findTop20ByStatusOrderByPriorityDescCreatedAtAsc(TaskStatus.READY)) {
            if (!dependencyService.dispatchable(task.getId())) {
                dependencyService.reconcile(task.getId());
                continue;
            }
            AgentEntity agent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
            if (agent == null || agent.getRole() == AgentRole.OPERATIONAL
                    || agent.getQueueMode() != AgentQueueMode.AUTO || agent.getStatus() != AgentStatus.IDLE) continue;
            dispatch(task, agent);
        }
    }

    @Transactional
    public TaskEntity dispatchManually(UUID taskId) {
        TaskEntity task = taskRepository.findById(taskId)
                .orElseThrow(() -> new NoSuchElementException("Task not found: " + taskId));
        UUID assignedAgentId = task.getAssignedAgentId();
        AgentEntity agent = agentRepository.findById(assignedAgentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + assignedAgentId));
        if (agent.getRole() == AgentRole.OPERATIONAL) {
            throw new IllegalStateException("Operational Agent does not accept normal task dispatch");
        }
        if (agent.getStatus() != AgentStatus.IDLE) throw new IllegalStateException("Agent is not idle");
        if (task.getStatus() != TaskStatus.READY && task.getStatus() != TaskStatus.BLOCKED
                && task.getStatus() != TaskStatus.WAITING_DEPENDENCY) {
            throw new IllegalStateException("Task is not dispatchable from status " + task.getStatus());
        }
        TaskDependencyService.Evaluation dependencies = dependencyService.reconcile(taskId);
        if (dependencies.state() != TaskDependencyService.State.READY) {
            throw new IllegalStateException("Task dependencies are not satisfied: " + dependencies.reason());
        }
        task = taskRepository.findById(taskId).orElse(task);
        dispatch(task, agent);
        return taskRepository.findById(taskId).orElse(task);
    }

    private void dispatch(TaskEntity task, AgentEntity agent) {
        dependencyService.requireReady(task.getId());
        try {
            task.setStatus(TaskStatus.DISPATCHING);
            task.setLastError(null);
            taskRepository.save(task);
            String clientMessageId = "agenticform-task:" + task.getId()
                    + (agent.getExecutionNodeId() == null ? "" : ":g" + agent.getRuntimeGeneration());

            if (agent.getExecutionNodeId() != null) {
                if (runtimeSessionId(agent) == null || runtimeSessionId(agent).isBlank()) {
                    throw new IllegalStateException("Remote agent runtime is not ready");
                }
                var command = nodeService.enqueue(agent.getExecutionNodeId(), agent.getId(), "DISPATCH_TASK",
                        dispatchKey(task, agent), Map.of(
                                "taskId", task.getId().toString(),
                                "runtimeType", runtimeType(agent).name(),
                                "runtimeSessionId", runtimeSessionId(agent),
                                "clientMessageId", clientMessageId,
                        "prompt", promptWithCompletionContract(task.getPrompt())));
                task.setQueuedSubmissionId("node-command:" + command.getId());
                task.setTurnId(null);
                task.setStatus(TaskStatus.DISPATCHED);
                taskRepository.save(task);
                agent.setStatus(AgentStatus.WORKING);
                agent.setActiveTaskId(task.getId());
                agent.setActiveTurnId(null);
                agentRepository.save(agent);
                return;
            }

            RuntimeDispatchReceipt receipt = runtimeRegistry.get(agent.getRuntimeType()).dispatch(
                    new RuntimeSession(agent.getRuntimeSessionId()), clientMessageId, promptWithCompletionContract(task.getPrompt()));
            TaskEntity currentTask = taskRepository.findById(task.getId()).orElse(task);
                currentTask.setQueuedSubmissionId(receipt.queuedSubmissionId());
                if (receipt.turnId() != null) currentTask.setTurnId(receipt.turnId());
            if (currentTask.getStatus() == TaskStatus.DISPATCHING) {
                currentTask.setStatus(receipt.turnId() == null ? TaskStatus.DISPATCHED : TaskStatus.RUNNING);
            }
            taskRepository.save(currentTask);

            if (receipt.turnId() != null && currentTask.getStatus() == TaskStatus.RUNNING) {
                AgentEntity currentAgent = agentRepository.findById(agent.getId()).orElse(agent);
                currentAgent.setStatus(AgentStatus.WORKING);
                currentAgent.setActiveTaskId(currentTask.getId());
                currentAgent.setActiveTurnId(receipt.turnId());
                agentRepository.save(currentAgent);
            }
        } catch (RuntimeException e) {
            TaskEntity currentTask = taskRepository.findById(task.getId()).orElse(task);
            currentTask.setStatus(TaskStatus.BLOCKED);
            currentTask.setLastError(e.getMessage());
            taskRepository.save(currentTask);
            AgentEntity currentAgent = agentRepository.findById(agent.getId()).orElse(agent);
            currentAgent.setStatus(AgentStatus.DISCONNECTED);
            agentRepository.save(currentAgent);
        }
    }

    private String runtimeSessionId(AgentEntity agent) {
        return agent.getRuntimeSessionId();
    }

    private RuntimeType runtimeType(AgentEntity agent) {
        return agent.getRuntimeType();
    }

    private String dispatchKey(TaskEntity task, AgentEntity agent) {
        return "dispatch-task:" + task.getId() + ":g" + agent.getRuntimeGeneration()
                + ":a" + (task.getUpdatedAt() == null ? System.nanoTime() : task.getUpdatedAt().toEpochMilli());
    }

    public static String promptWithCompletionContract(String prompt) {
        return prompt + COMPLETION_CONTRACT;
    }
}
