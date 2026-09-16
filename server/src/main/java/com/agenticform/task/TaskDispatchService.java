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
        return create(agentId, title, prompt, priority, dependencies, parentTaskId, requestedKind, null);
    }

    /**
     * Requested deliverable contract. Persisted at creation so completion never
     * depends on prompt wording.
     */
    public record DeliveryRequest(TaskDeliverable deliverable, Boolean reviewRequired,
                                 Boolean architectureRequired, Boolean deploymentRequired,
                                 String environmentKey) {}

    @Transactional
    public TaskEntity create(UUID agentId, String title, String prompt, int priority,
                             List<TaskDependencyService.DependencyRequest> dependencies, UUID parentTaskId,
                             TaskKind requestedKind, DeliveryRequest requestedDelivery) {
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
        DeliveryRequest delivery = requestedDelivery == null ? defaultDelivery(kind) : requestedDelivery;
        TaskDeliverable deliverable = delivery.deliverable() == null ? deliverableFor(kind) : delivery.deliverable();
        if (deliverable == TaskDeliverable.OPERATIONS
                || (requestedDelivery != null && delivery.deliverable() == TaskDeliverable.OPERATIONS)) {
            throw new IllegalArgumentException("Operational work must use the operational handoff");
        }
        if (deliverable == TaskDeliverable.IMPLEMENTATION
                && !agent.getCapabilityProfile().allows(AgentCapabilityProfile.Capability.WRITE)) {
            throw new IllegalArgumentException("Implementation deliverables require an agent with WRITE capability");
        }
        boolean reviewRequired = delivery.reviewRequired() == null
                ? deliverable == TaskDeliverable.IMPLEMENTATION : delivery.reviewRequired();
        boolean architectureRequired = delivery.architectureRequired() != null && delivery.architectureRequired();
        // Only the workflow root carries the delivery obligation; children are
        // milestones whose artifacts the root gate consumes.
        boolean deploymentRequired = parentTaskId == null && (delivery.deploymentRequired() == null
                ? deliverable == TaskDeliverable.IMPLEMENTATION || kind == TaskKind.ORCHESTRATION
                : delivery.deploymentRequired());
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
        task.configureDelivery(deliverable, reviewRequired, architectureRequired, deploymentRequired,
                delivery.environmentKey());
        task = taskRepository.save(task);
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

    private DeliveryRequest defaultDelivery(TaskKind kind) {
        return switch (kind) {
            case IMPLEMENTATION -> new DeliveryRequest(TaskDeliverable.IMPLEMENTATION, true, false, true, null);
            default -> new DeliveryRequest(deliverableFor(kind), false, false, false, null);
        };
    }

    private TaskDeliverable deliverableFor(TaskKind kind) {
        return switch (kind) {
            case ARCHITECTURE -> TaskDeliverable.ANALYSIS;
            case IMPLEMENTATION -> TaskDeliverable.IMPLEMENTATION;
            case REVIEW -> TaskDeliverable.REVIEW;
            case TEST -> TaskDeliverable.TEST;
            case OPERATIONS -> TaskDeliverable.OPERATIONS;
            case ORCHESTRATION, GENERAL -> TaskDeliverable.GENERAL;
        };
    }

    private TaskDeliverable deliverableOf(TaskEntity task) {
        return task.getDeliverable() == null ? TaskDeliverable.GENERAL : task.getDeliverable();
    }

    /**
     * Resolve the workflow-root task an operational run may deliver. Returns null
     * when the candidate is not a root application task in this project, so a
     * non-delivery operation never binds to an unrelated task.
     */
    public UUID resolveDeliverableRoot(UUID projectId, UUID explicitTaskId, UUID activeTaskId) {
        UUID resolved = resolveDeliverableRoot(projectId, explicitTaskId);
        return resolved != null ? resolved : resolveDeliverableRoot(projectId, activeTaskId);
    }

    public UUID resolveDeliverableRoot(UUID projectId, UUID candidateTaskId) {
        if (projectId == null || candidateTaskId == null) return null;
        TaskEntity candidate = taskRepository.findById(candidateTaskId).orElse(null);
        if (candidate == null || !projectId.equals(candidate.getProjectId())) return null;
        if (candidate.getParentTaskId() != null) return null;
        if (deliverableOf(candidate) != TaskDeliverable.IMPLEMENTATION) return null;
        return candidate.getId();
    }

    @Transactional
    public TaskEntity report(UUID agentId, UUID taskId, long runtimeGeneration, String report) {
        return report(agentId, taskId, runtimeGeneration, report, null);
    }

    /**
     * Durable task report. A successful outcome is accepted only when the persisted
     * deliverable contract is satisfied by structured evidence; prose is retained for
     * humans but is never used to prove completion.
     */
    @Transactional
    public TaskEntity report(UUID agentId, UUID taskId, long runtimeGeneration, String report,
                             TaskEvidence evidence) {
        AgentEntity agent = agentRepository.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        TaskEntity task = taskRepository.findById(taskId)
                .orElseThrow(() -> new NoSuchElementException("Task not found: " + taskId));
        requireReportIdentity(agent, task, taskId, runtimeGeneration);
        if (report == null || report.isBlank()) throw new IllegalArgumentException("Task report is required");
        if (report.length() > 20000) throw new IllegalArgumentException("Task report is too long");
        String outcome = evidence == null ? TaskEvidence.COMPLETED : TaskEvidence.normalizeOutcome(evidence.outcome());
        if (outcome == null) outcome = TaskEvidence.COMPLETED;
        // Validate the workflow graph before the leaf evidence contract so an
        // orchestrator can never complete on a partial or missing child set.
        if (agent.getRole() == AgentRole.ORCHESTRATOR) {
            List<TaskEntity> descendants = descendants(taskId);
            List<TaskEntity> unfinished = descendants.stream()
                    .filter(child -> child.getStatus() != TaskStatus.COMPLETED
                            || (child.getEvidence() != null && child.getEvidence().hasUnresolvedBlocker()))
                    .toList();
            if (!unfinished.isEmpty()) {
                throw new IllegalStateException("Orchestrator cannot complete while delegated tasks remain unresolved: "
                        + unfinished.stream().map(child -> child.getId() + "=" + child.getStatus()).toList());
            }
            requireDescendantEvidence(task, descendants);
        }
        if (TaskEvidence.COMPLETED.equals(outcome)) {
            requireCompletionEvidence(task, evidence);
        }
        task.setReport(report.trim());
        if (evidence != null) {
            task.recordEvidence(evidence);
        }
        return taskRepository.save(task);
    }

    private void requireCompletionEvidence(TaskEntity task, TaskEvidence evidence) {
        if (task.requiresVerifiedDelivery()) {
            if (task.getEnvironmentKey() == null || task.getEnvironmentKey().isBlank()) {
                throw new ReportRejectedException("DELIVERY_CONFIGURATION_REQUIRED", task.getId(), task.getAssignedAgentId(),
                        "Record the intended environment/service, then hand the validated artifact to operations");
            }
            if (!task.hasVerifiedDelivery()) {
                throw new ReportRejectedException("DELIVERY_NOT_VERIFIED", task.getId(), task.getAssignedAgentId(),
                        "Application changes are delivered only after verified deployment; hand off to operations and verify the target");
            }
        }
        if (evidence == null) {
            if (deliverableOf(task) == TaskDeliverable.GENERAL) return;
            throw new ReportRejectedException("EVIDENCE_REQUIRED", task.getId(), task.getAssignedAgentId(),
                    "Submit structured evidence (outcome, artifacts, validations, blockers, follow-up); prose alone does not prove completion");
        }
        if (evidence.hasUnresolvedBlocker()) {
            throw new ReportRejectedException("UNRESOLVED_BLOCKERS", task.getId(), task.getAssignedAgentId(),
                    "Resolve blockers or report the task as BLOCKED instead of COMPLETED");
        }
        switch (deliverableOf(task)) {
            // Root orchestration completeness is proved by required descendant
            // phases and the deployment gate above, not by prose.
            case GENERAL -> { }
            case ANALYSIS -> {
                if (!evidence.hasArtifact(TaskEvidence.ArtifactType.ANALYSIS)
                        && !evidence.hasArtifact(TaskEvidence.ArtifactType.DOCUMENT)) {
                    throw new ReportRejectedException("ANALYSIS_EVIDENCE_REQUIRED", task.getId(), task.getAssignedAgentId(),
                            "Analysis tasks complete with an analysis or document artifact reference");
                }
            }
            case DOCUMENTATION -> {
                if (!evidence.hasArtifact(TaskEvidence.ArtifactType.DOCUMENT)
                        || !evidence.hasPassedValidation()) {
                    throw new ReportRejectedException("DOCUMENTATION_EVIDENCE_REQUIRED", task.getId(), task.getAssignedAgentId(),
                            "Documentation tasks complete with a document reference and a passed documentation validation");
                }
            }
            case IMPLEMENTATION -> {
                if (!evidence.hasRevisionedArtifact(TaskEvidence.ArtifactType.COMMIT)
                        && !evidence.hasRevisionedArtifact(TaskEvidence.ArtifactType.PULL_REQUEST)) {
                    throw new ReportRejectedException("IMPLEMENTATION_EVIDENCE_REQUIRED", task.getId(), task.getAssignedAgentId(),
                            "Implementation tasks complete with a revisioned commit or pull-request artifact");
                }
                if (!evidence.hasPassedValidation()) {
                    throw new ReportRejectedException("VALIDATION_REQUIRED", task.getId(), task.getAssignedAgentId(),
                            "Implementation tasks complete only with at least one passed validation");
                }
            }
            case REVIEW -> {
                if (!evidence.hasArtifact(TaskEvidence.ArtifactType.REVIEW)
                        || !evidence.hasPassedValidation()) {
                    throw new ReportRejectedException("REVIEW_EVIDENCE_REQUIRED", task.getId(), task.getAssignedAgentId(),
                            "Review tasks complete with a review artifact and a passed validation");
                }
            }
            case TEST -> {
                if (!evidence.hasArtifact(TaskEvidence.ArtifactType.TEST_RUN)
                        || !evidence.hasPassedValidation()) {
                    throw new ReportRejectedException("TEST_EVIDENCE_REQUIRED", task.getId(), task.getAssignedAgentId(),
                            "Test tasks complete with a test-run artifact and a passed validation");
                }
            }
            case OPERATIONS -> {
                if (!evidence.hasArtifact(TaskEvidence.ArtifactType.OPERATION_RUN)) {
                    throw new ReportRejectedException("OPERATION_EVIDENCE_REQUIRED", task.getId(), task.getAssignedAgentId(),
                            "Operations tasks complete with an operation-run artifact reference");
                }
            }
        }
    }

    private void requireDescendantEvidence(TaskEntity task, List<TaskEntity> descendants) {
        // Record the review milestone on the root as soon as a review child has
        // completed, so the UI can distinguish implementation-finished from
        // review-passed before deployment begins.
        if (descendants.stream().anyMatch(child -> deliverableOf(child) == TaskDeliverable.REVIEW
                && child.getStatus() == TaskStatus.COMPLETED)) {
            task.recordReviewPassed();
        }
        TaskDeliverable deliverable = deliverableOf(task);
        if (deliverable != TaskDeliverable.IMPLEMENTATION) {
            if (task.isArchitectureRequired() && descendants.stream().noneMatch(child ->
                    deliverableOf(child) == TaskDeliverable.ANALYSIS && child.getStatus() == TaskStatus.COMPLETED)) {
                throw new ReportRejectedException("ARCHITECTURE_CHILD_REQUIRED", task.getId(), task.getAssignedAgentId(),
                        "This workflow requires a completed architecture child task");
            }
            if (task.isReviewRequired() && descendants.stream().noneMatch(child ->
                    deliverableOf(child) == TaskDeliverable.REVIEW && child.getStatus() == TaskStatus.COMPLETED)) {
                throw new ReportRejectedException("REVIEW_CHILD_REQUIRED", task.getId(), task.getAssignedAgentId(),
                        "This workflow requires a completed review child task");
            }
            return;
        }
        if (task.isArchitectureRequired() && descendants.stream().noneMatch(child ->
                deliverableOf(child) == TaskDeliverable.ANALYSIS && child.getStatus() == TaskStatus.COMPLETED)) {
            throw new ReportRejectedException("ARCHITECTURE_CHILD_REQUIRED", task.getId(), task.getAssignedAgentId(),
                    "Implementation workflow requires a completed architecture child task");
        }
        boolean hasImplementation = descendants.stream().anyMatch(child ->
                deliverableOf(child) == TaskDeliverable.IMPLEMENTATION
                        && child.getStatus() == TaskStatus.COMPLETED
                        && child.getEvidence() != null
                        && (child.getEvidence().hasRevisionedArtifact(TaskEvidence.ArtifactType.COMMIT)
                            || child.getEvidence().hasRevisionedArtifact(TaskEvidence.ArtifactType.PULL_REQUEST))
                        && child.getEvidence().hasPassedValidation());
        if (!hasImplementation) {
            throw new ReportRejectedException("IMPLEMENTATION_CHILD_REQUIRED", task.getId(), task.getAssignedAgentId(),
                    "Implementation workflow requires a completed implementation child with revisioned artifacts and passed validation");
        }
        if (task.isReviewRequired() && descendants.stream().noneMatch(child ->
                deliverableOf(child) == TaskDeliverable.REVIEW && child.getStatus() == TaskStatus.COMPLETED)) {
            throw new ReportRejectedException("REVIEW_CHILD_REQUIRED", task.getId(), task.getAssignedAgentId(),
                    "Implementation workflow requires a completed review child task");
        }
    }

    @Transactional
    public TaskEntity block(UUID agentId, UUID taskId, long runtimeGeneration, String reason) {
        AgentEntity agent = agentRepository.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        TaskEntity task = taskRepository.findById(taskId)
                .orElseThrow(() -> new NoSuchElementException("Task not found: " + taskId));
        requireReportIdentity(agent, task, taskId, runtimeGeneration);
        if (reason == null || reason.isBlank() || reason.length() > 20000) throw new IllegalArgumentException("Blocker must contain 1 to 20000 characters");
        task.setStatus(TaskStatus.BLOCKED);
        task.setLastError(reason);
        task.setReport("BLOCKER: " + reason);
        return taskRepository.save(task);
    }

    private void requireReportIdentity(AgentEntity agent, TaskEntity task, UUID taskId, long runtimeGeneration) {
        if (!task.getAssignedAgentId().equals(agent.getId()) || !task.getProjectId().equals(agent.getProjectId())) {
            throw new IllegalArgumentException("Agent may only report its own project task");
        }
        if (runtimeGeneration < 0 || (agent.getExecutionNodeId() != null && runtimeGeneration == 0)
                || runtimeGeneration != agent.getRuntimeGeneration()) {
            throw new ReportRejectedException("STALE_RUNTIME", taskId, agent.getActiveTaskId(), "Inspect the current runtime; do not resubmit an old report under a new generation");
        }
        if (!taskId.equals(agent.getActiveTaskId())) {
            throw new ReportRejectedException("STALE_TASK", taskId, agent.getActiveTaskId(), "Inspect the original task; do not attach this report to another task");
        }
        if (task.getStatus() != TaskStatus.DISPATCHED && task.getStatus() != TaskStatus.RUNNING) {
            throw new ReportRejectedException("TASK_NOT_REPORTABLE", taskId, agent.getActiveTaskId(), "Resolve the task blocker or approval before reporting; do not create a replacement task");
        }
    }

    private List<TaskEntity> descendants(UUID parentTaskId) {
        List<TaskEntity> result = new java.util.ArrayList<>();
        for (TaskEntity child : taskRepository.findAllByParentTaskIdOrderByCreatedAtAsc(parentTaskId)) {
            result.add(child);
            result.addAll(descendants(child.getId()));
        }
        return result;
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
    public void reconcileOrchestration(UUID taskId) {
        TaskEntity task = taskRepository.findById(taskId).orElse(null);
        if (task == null || task.getKind() != TaskKind.ORCHESTRATION
                || task.getStatus() != TaskStatus.WAITING_DEPENDENCY) return;
        List<TaskEntity> descendants = descendants(taskId);
        boolean allTerminal = !descendants.isEmpty() && descendants.stream().allMatch(child ->
                child.getStatus() == TaskStatus.COMPLETED
                        || child.getStatus() == TaskStatus.BLOCKED
                        || child.getStatus() == TaskStatus.FAILED
                        || child.getStatus() == TaskStatus.CANCELLED);
        if (allTerminal) {
            task.setStatus(TaskStatus.READY);
            task.setLastError(null);
            taskRepository.save(task);
        }
    }

    public boolean hasDescendants(UUID taskId) {
        return !descendants(taskId).isEmpty();
    }

    @Transactional
    public void reconcileOrchestrationParents(UUID childTaskId) {
        TaskEntity child = taskRepository.findById(childTaskId).orElse(null);
        if (child == null || child.getParentTaskId() == null) return;
        UUID parentId = child.getParentTaskId();
        while (parentId != null) {
            reconcileOrchestration(parentId);
            parentId = taskRepository.findById(parentId).map(TaskEntity::getParentTaskId).orElse(null);
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
                        "prompt", promptWithCompletionContract(task, agent)));
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
                    new RuntimeSession(agent.getRuntimeSessionId()), clientMessageId, promptWithCompletionContract(task, agent));
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

    public static String promptWithCompletionContract(TaskEntity task, AgentEntity agent) {
        return task.getPrompt() + COMPLETION_CONTRACT + "\nReport identity: taskId=" + task.getId()
                + "; runtimeGeneration=" + agent.getRuntimeGeneration()
                + ". Pass both unchanged to report_task. A RESULT message does not submit a task report.";
    }

    public static class ReportRejectedException extends IllegalStateException {
        public final String code;
        public final UUID taskId;
        public final UUID activeTaskId;

        public ReportRejectedException(String code, UUID taskId, UUID activeTaskId, String nextAction) {
            super(nextAction);
            this.code = code;
            this.taskId = taskId;
            this.activeTaskId = activeTaskId;
        }
    }
}
