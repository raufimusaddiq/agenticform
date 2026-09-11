package com.agenticform.message;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.agent.AgentStatus;
import com.agenticform.codex.CodexGateway;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class AgentMessageService {
    public static final int MAX_HOPS = 6;

    private final AgentMessageRepository repository;
    private final AgentRepository agentRepository;
    private final CodexGateway codexGateway;

    public AgentMessageService(AgentMessageRepository repository, AgentRepository agentRepository,
                               CodexGateway codexGateway) {
        this.repository = repository;
        this.agentRepository = agentRepository;
        this.codexGateway = codexGateway;
    }

    public List<AgentMessageEntity> list(UUID projectId, UUID agentId) {
        if (agentId != null) {
            return repository.findAllByToAgentIdOrderByCreatedAtDesc(agentId);
        }
        if (projectId != null) {
            return repository.findAllByProjectIdOrderByCreatedAtDesc(projectId);
        }
        return repository.findAll();
    }

    public List<AgentMessageEntity> conversation(UUID conversationId) {
        return repository.findAllByConversationIdOrderByCreatedAtAsc(conversationId);
    }

    @Transactional
    public AgentMessageEntity send(UUID fromAgentId, UUID toAgentId, AgentMessageType type,
                                   String subject, String content, UUID replyToMessageId) {
        AgentEntity source = agent(fromAgentId);
        AgentEntity target = agent(toAgentId);

        if (!source.getProjectId().equals(target.getProjectId())) {
            throw new IllegalStateException("Cross-project agent messaging is disabled until an explicit permission policy allows it");
        }
        if (target.getStatus() == AgentStatus.STOPPED) {
            throw new IllegalStateException("Target agent is stopped");
        }

        UUID conversationId = UUID.randomUUID();
        int hopCount = 0;
        if (replyToMessageId != null) {
            AgentMessageEntity parent = repository.findById(replyToMessageId)
                    .orElseThrow(() -> new NoSuchElementException("Reply target message not found: " + replyToMessageId));
            if (!parent.getToAgentId().equals(source.getId())) {
                throw new IllegalArgumentException("An agent may only reply to a message addressed to that agent");
            }
            if (!parent.getFromAgentId().equals(target.getId())) {
                throw new IllegalArgumentException("Reply target agent must be the sender of the parent message");
            }
            conversationId = parent.getConversationId();
            hopCount = parent.getHopCount() + 1;
        }

        if (hopCount >= MAX_HOPS) {
            throw new IllegalStateException("Agent conversation reached the maximum hop count of " + MAX_HOPS);
        }

        AgentMessageType resolvedType = type == null ? AgentMessageType.INFORMATION : type;
        AgentMessageEntity message = repository.save(new AgentMessageEntity(
                source.getProjectId(), source.getId(), target.getId(), conversationId,
                replyToMessageId, resolvedType, subject, content, hopCount));

        try {
            CodexGateway.DispatchReceipt receipt = codexGateway.dispatchTask(
                    target.getCodexThreadId(),
                    "agenticform-message:" + message.getId(),
                    deliveryPrompt(message, source, target));
            message.markDispatched(receipt.queuedSubmissionId(), receipt.turnId());
            return repository.save(message);
        } catch (RuntimeException error) {
            message.markFailed(error.getMessage());
            repository.save(message);
            throw error;
        }
    }

    private AgentEntity agent(UUID id) {
        return agentRepository.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + id));
    }

    private String deliveryPrompt(AgentMessageEntity message, AgentEntity source, AgentEntity target) {
        return """
                You received a structured message from another Agenticform agent.

                Message ID: %s
                Conversation ID: %s
                From agent: %s (%s)
                To agent: %s (%s)
                Type: %s
                Subject: %s
                Hop: %d/%d

                Message:
                %s

                Treat this as inter-agent communication, not as a new user requirement unless the message asks for work.
                If a response is necessary, use the agenticform/send_message tool and set replyToMessageId to %s.
                Do not reply merely to acknowledge INFORMATION messages.
                """.formatted(
                message.getId(), message.getConversationId(), source.getName(), source.getId(),
                target.getName(), target.getId(), message.getType(), message.getSubject(),
                message.getHopCount(), MAX_HOPS, message.getContent(), message.getId());
    }
}
