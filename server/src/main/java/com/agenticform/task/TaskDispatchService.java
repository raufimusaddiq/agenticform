package com.agenticform.task;

import com.agenticform.agent.AgentEntity;
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
        return create(agentId, title, prompt, priority, List.of());
    }

    @Transactional
    public TaskEntity create(UUID agentId, String title, String prompt, int priority,
                             List<TaskDependencyService.DependencyRequest> dependencies) {
        AgentEntity agent = agentRepository.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        if (agent.getRole() == AgentRole.OPERATIONAL) {
            throw new IllegalArgumentException("Operational Agent does not accept normal tasks; use agent-to-agent operational handoff");
        }
        TaskEntity task = taskRepository.save(new TaskEntity(agent.getProjectId(), agentId, title, prompt, priority));
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
        task.setReport(report.trim());
        return taskRepository.save(task);
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
                        "dispatch-task:" + task.getId() + ":g" + agent.getRuntimeGeneration(), Map.of(
                                "taskId", task.getId().toString(),
                                "runtimeType", runtimeType(agent).name(),
                                "runtimeSessionId", runtimeSessionId(agent),
                                "clientMessageId", clientMessageId,
                                "prompt", task.getPrompt()));
                task.setQueuedSubmissionId("node-command:" + command.getId());
                task.setStatus(TaskStatus.DISPATCHED);
                taskRepository.save(task);
                agent.setStatus(AgentStatus.WORKING);
                agent.setActiveTaskId(task.getId());
                agent.setActiveTurnId(null);
                agentRepository.save(agent);
                return;
            }

            RuntimeDispatchReceipt receipt = runtimeRegistry.get(agent.getRuntimeType()).dispatch(
                    new RuntimeSession(agent.getRuntimeSessionId()), clientMessageId, task.getPrompt());
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
}
