package com.agenticform.task;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentQueueMode;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.codex.CodexGateway;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class TaskDispatchService {
    private final TaskRepository taskRepository;
    private final AgentRepository agentRepository;
    private final CodexGateway codexGateway;

    public TaskDispatchService(TaskRepository taskRepository, AgentRepository agentRepository, CodexGateway codexGateway) {
        this.taskRepository = taskRepository;
        this.agentRepository = agentRepository;
        this.codexGateway = codexGateway;
    }

    public List<TaskEntity> list(UUID projectId) {
        return projectId == null ? taskRepository.findAll() : taskRepository.findAllByProjectIdOrderByCreatedAtDesc(projectId);
    }

    @Transactional
    public TaskEntity create(UUID agentId, String title, String prompt, int priority) {
        AgentEntity agent = agentRepository.findById(agentId)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + agentId));
        return taskRepository.save(new TaskEntity(agent.getProjectId(), agentId, title, prompt, priority));
    }

    public synchronized void dispatchReadyTasks() {
        for (TaskEntity task : taskRepository.findTop20ByStatusOrderByPriorityDescCreatedAtAsc(TaskStatus.READY)) {
            AgentEntity agent = agentRepository.findById(task.getAssignedAgentId()).orElse(null);
            if (agent == null || agent.getQueueMode() != AgentQueueMode.AUTO || agent.getStatus() != AgentStatus.IDLE) {
                continue;
            }
            dispatch(task, agent);
        }
    }

    @Transactional
    public TaskEntity dispatchManually(UUID taskId) {
        TaskEntity task = taskRepository.findById(taskId)
                .orElseThrow(() -> new NoSuchElementException("Task not found: " + taskId));
        AgentEntity agent = agentRepository.findById(task.getAssignedAgentId())
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + task.getAssignedAgentId()));
        if (agent.getStatus() != AgentStatus.IDLE) {
            throw new IllegalStateException("Agent is not idle");
        }
        if (task.getStatus() != TaskStatus.READY && task.getStatus() != TaskStatus.BLOCKED) {
            throw new IllegalStateException("Task is not dispatchable from status " + task.getStatus());
        }
        dispatch(task, agent);
        return task;
    }

    private void dispatch(TaskEntity task, AgentEntity agent) {
        try {
            task.setStatus(TaskStatus.DISPATCHING);
            task.setLastError(null);
            taskRepository.save(task);

            String clientMessageId = "agenticform-task:" + task.getId();
            CodexGateway.DispatchReceipt receipt = codexGateway.dispatchTask(
                    agent.getCodexThreadId(), clientMessageId, task.getPrompt());

            task.setCodexQueuedSubmissionId(receipt.queuedSubmissionId());
            task.setCodexTurnId(receipt.turnId());
            task.setStatus(receipt.turnId() == null ? TaskStatus.DISPATCHED : TaskStatus.RUNNING);
            agent.setStatus(AgentStatus.WORKING);
            agent.setActiveTaskId(task.getId());
            agent.setActiveTurnId(receipt.turnId());
            taskRepository.save(task);
            agentRepository.save(agent);
        } catch (RuntimeException e) {
            task.setStatus(TaskStatus.BLOCKED);
            task.setLastError(e.getMessage());
            agent.setStatus(AgentStatus.DISCONNECTED);
            taskRepository.save(task);
            agentRepository.save(agent);
        }
    }
}
