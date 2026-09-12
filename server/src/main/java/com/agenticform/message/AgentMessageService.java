package com.agenticform.message;

import com.agenticform.agent.AgentEntity;
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
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class AgentMessageService {
    public static final int MAX_HOPS = 6;
    public static final int MAX_FANOUT = 24;

    public record AudienceRequest(AgentMessageAudienceType type, List<UUID> agentIds,
                                  AgentRole role, UUID groupId) {}
    public record SendResult(AgentMessageEntity message, List<AgentMessageDeliveryEntity> deliveries) {}

    private final AgentMessageRepository repository;
    private final AgentMessageDeliveryRepository deliveryRepository;
    private final AgentRepository agentRepository;
    private final AgentGroupRepository groupRepository;
    private final AgentGroupMembershipRepository membershipRepository;
    private final CommunicationRuleService communicationRules;
    private final AgentRuntimeRegistry runtimeRegistry;
    private final ExecutionNodeService nodeService;
    private final ObjectMapper mapper;

    public AgentMessageService(AgentMessageRepository repository,
                               AgentMessageDeliveryRepository deliveryRepository,
                               AgentRepository agentRepository,
                               AgentGroupRepository groupRepository,
                               AgentGroupMembershipRepository membershipRepository,
                               CommunicationRuleService communicationRules,
                               AgentRuntimeRegistry runtimeRegistry,
                               ExecutionNodeService nodeService,
                               ObjectMapper mapper) {
        this.repository = repository;
        this.deliveryRepository = deliveryRepository;
        this.agentRepository = agentRepository;
        this.groupRepository = groupRepository;
        this.membershipRepository = membershipRepository;
        this.communicationRules = communicationRules;
        this.runtimeRegistry = runtimeRegistry;
        this.nodeService = nodeService;
        this.mapper = mapper;
    }

    public List<AgentMessageEntity> list(UUID projectId, UUID agentId) {
        if (agentId != null) {
            return deliveryRepository.findAllByToAgentIdOrderByCreatedAtDesc(agentId).stream()
                    .map(delivery -> repository.findById(delivery.getMessageId()).orElse(null))
                    .filter(java.util.Objects::nonNull).distinct().toList();
        }
        if (projectId != null) return repository.findAllByProjectIdOrderByCreatedAtDesc(projectId);
        return repository.findAll();
    }

    public List<AgentMessageEntity> conversation(UUID conversationId) {
        return repository.findAllByConversationIdOrderByCreatedAtAsc(conversationId);
    }

    public List<AgentMessageDeliveryEntity> deliveries(UUID messageId) {
        return deliveryRepository.findAllByMessageIdOrderByCreatedAtAsc(messageId);
    }

    public AgentMessageEntity send(UUID fromAgentId, UUID toAgentId, AgentMessageType type,
                                   String subject, String content, UUID replyToMessageId) {
        return sendAudience(fromAgentId,
                new AudienceRequest(AgentMessageAudienceType.DIRECT, List.of(toAgentId), null, null),
                type, subject, content, replyToMessageId).message();
    }

    @Transactional
    public SendResult sendAudience(UUID fromAgentId, AudienceRequest requestedAudience,
                                   AgentMessageType type, String subject, String content,
                                   UUID replyToMessageId) {
        AgentEntity source = agent(fromAgentId);
        AgentMessageAudienceType audienceType = requestedAudience == null || requestedAudience.type() == null
                ? AgentMessageAudienceType.DIRECT : requestedAudience.type();

        UUID conversationId = UUID.randomUUID();
        int hopCount = 0;
        AgentMessageEntity parent = null;
        if (replyToMessageId != null) {
            parent = repository.findById(replyToMessageId)
                    .orElseThrow(() -> new NoSuchElementException("Reply target message not found: " + replyToMessageId));
            if (deliveryRepository.findByMessageIdAndToAgentId(parent.getId(), source.getId()).isEmpty()) {
                throw new IllegalArgumentException("An agent may only reply to a message delivered to that agent");
            }
            conversationId = parent.getConversationId();
            hopCount = parent.getHopCount() + 1;
            if (audienceType != AgentMessageAudienceType.DIRECT) {
                throw new IllegalArgumentException("Replies are direct by default; use a new message for multicast or broadcast");
            }
        }
        if (hopCount >= MAX_HOPS) throw new IllegalStateException("Agent conversation reached the maximum hop count of " + MAX_HOPS);

        List<AgentEntity> recipients = resolveAudience(source, requestedAudience, parent);
        if (recipients.isEmpty()) throw new IllegalArgumentException("Message audience resolved to no recipients");
        if (recipients.size() > MAX_FANOUT) throw new IllegalArgumentException("Message fanout exceeds limit of " + MAX_FANOUT);

        String audienceSpec = audienceSpec(audienceType, requestedAudience, recipients);
        UUID directTarget = audienceType == AgentMessageAudienceType.DIRECT ? recipients.get(0).getId() : null;
        AgentMessageEntity message = repository.save(new AgentMessageEntity(
                source.getProjectId(), source.getId(), directTarget, conversationId,
                replyToMessageId, type == null ? AgentMessageType.INFORMATION : type,
                audienceType, audienceSpec, normalize(subject, "subject", 255),
                normalize(content, "content", 20_000), hopCount));

        List<AgentMessageDeliveryEntity> deliveries = new ArrayList<>();
        for (AgentEntity recipient : recipients) {
            AgentMessageDeliveryEntity delivery = deliveryRepository.save(
                    new AgentMessageDeliveryEntity(message.getId(), recipient.getId()));
            dispatch(message, delivery, source, recipient);
            deliveries.add(deliveryRepository.findById(delivery.getId()).orElse(delivery));
        }
        updateAggregate(message, deliveries);
        return new SendResult(repository.save(message), List.copyOf(deliveries));
    }

    @Transactional
    public SendResult retry(UUID messageId) {
        AgentMessageEntity message = repository.findById(messageId)
                .orElseThrow(() -> new NoSuchElementException("Message not found: " + messageId));
        AgentEntity source = agent(message.getFromAgentId());
        List<AgentMessageDeliveryEntity> deliveries = deliveryRepository.findAllByMessageIdOrderByCreatedAtAsc(messageId);
        for (AgentMessageDeliveryEntity delivery : deliveries) {
            if (List.of(AgentMessageStatus.QUEUED, AgentMessageStatus.DISPATCHED,
                    AgentMessageStatus.PROCESSING, AgentMessageStatus.COMPLETED).contains(delivery.getStatus())
                    || delivery.getAttemptCount() >= 3) continue;
            AgentEntity target = agent(delivery.getToAgentId());
            communicationRules.require(source.getProjectId(), target.getProjectId(), CommunicationRuleEntity.Action.MESSAGE);
            delivery.resetForRetry();
            deliveryRepository.save(delivery);
            dispatch(message, delivery, source, target);
        }
        List<AgentMessageDeliveryEntity> current = deliveryRepository.findAllByMessageIdOrderByCreatedAtAsc(messageId);
        updateAggregate(message, current);
        return new SendResult(repository.save(message), current);
    }

    @Transactional
    public AgentMessageEntity refreshAggregate(UUID messageId) {
        AgentMessageEntity message = repository.findById(messageId)
                .orElseThrow(() -> new NoSuchElementException("Message not found: " + messageId));
        updateAggregate(message, deliveryRepository.findAllByMessageIdOrderByCreatedAtAsc(messageId));
        return repository.save(message);
    }

    private List<AgentEntity> resolveAudience(AgentEntity source, AudienceRequest audience, AgentMessageEntity parent) {
        AgentMessageAudienceType type = audience == null || audience.type() == null
                ? AgentMessageAudienceType.DIRECT : audience.type();
        LinkedHashSet<UUID> ids = new LinkedHashSet<>();
        switch (type) {
            case DIRECT -> {
                if (parent != null) {
                    ids.add(parent.getFromAgentId());
                } else if (audience == null || audience.agentIds() == null || audience.agentIds().size() != 1) {
                    throw new IllegalArgumentException("DIRECT audience requires exactly one agent id");
                } else {
                    ids.add(audience.agentIds().get(0));
                }
            }
            case MULTICAST -> {
                if (audience.agentIds() == null || audience.agentIds().isEmpty()) {
                    throw new IllegalArgumentException("MULTICAST audience requires agentIds");
                }
                ids.addAll(audience.agentIds());
            }
            case ROLE -> {
                if (audience == null || audience.role() == null) throw new IllegalArgumentException("ROLE audience requires role");
                agentRepository.findAllByProjectId(source.getProjectId()).stream()
                        .filter(agent -> agent.getRole() == audience.role())
                        .map(AgentEntity::getId).forEach(ids::add);
            }
            case GROUP -> {
                if (audience == null || audience.groupId() == null) throw new IllegalArgumentException("GROUP audience requires groupId");
                AgentGroupEntity group = groupRepository.findById(audience.groupId())
                        .orElseThrow(() -> new NoSuchElementException("Agent group not found: " + audience.groupId()));
                if (!source.getProjectId().equals(group.getProjectId())) throw new IllegalArgumentException("Agent group belongs to another project");
                membershipRepository.findAllByGroupId(group.getId()).stream()
                        .map(AgentGroupMembershipEntity::getAgentId).forEach(ids::add);
            }
            case PROJECT_BROADCAST -> agentRepository.findAllByProjectId(source.getProjectId()).stream()
                    .map(AgentEntity::getId).forEach(ids::add);
        }
        if (type != AgentMessageAudienceType.DIRECT) ids.remove(source.getId());

        List<AgentEntity> result = new ArrayList<>();
        for (UUID id : ids) {
            AgentEntity target = agent(id);
            boolean replyToAuthorizedSender = parent != null && target.getId().equals(parent.getFromAgentId());
            if (!replyToAuthorizedSender) {
                communicationRules.require(source.getProjectId(), target.getProjectId(), CommunicationRuleEntity.Action.MESSAGE);
            }
            if (target.getStatus() == AgentStatus.STOPPED) continue;
            result.add(target);
        }
        return List.copyOf(result);
    }

    private void dispatch(AgentMessageEntity message, AgentMessageDeliveryEntity delivery,
                          AgentEntity source, AgentEntity target) {
        try {
            if (target.getExecutionNodeId() != null) {
                if (runtimeSessionId(target) == null || runtimeSessionId(target).isBlank()) {
                    throw new IllegalStateException("Target remote runtime is not ready");
                }
                var command = nodeService.enqueue(target.getExecutionNodeId(), target.getId(), "DELIVER_MESSAGE",
                        "message:" + message.getId() + ":" + target.getId() + ":g" + target.getRuntimeGeneration(), Map.of(
                                "messageId", message.getId().toString(),
                                "conversationId", message.getConversationId().toString(),
                                "runtimeType", target.getRuntimeType().name(),
                                "runtimeSessionId", runtimeSessionId(target),
                                "threadId", runtimeSessionId(target),
                                "clientMessageId", "agenticform-message:" + message.getId() + ":" + delivery.getId()
                                        + ":g" + target.getRuntimeGeneration(),
                                "prompt", deliveryPrompt(message, source, target)));
                delivery.markQueuedOnNode(command.getId().toString());
            } else {
                if (runtimeSessionId(target) == null || runtimeSessionId(target).isBlank()) {
                    throw new IllegalStateException("Target agent runtime is not ready");
                }
                RuntimeDispatchReceipt receipt = runtimeRegistry.get(target.getRuntimeType()).dispatch(
                        new RuntimeSession(runtimeSessionId(target)),
                        "agenticform-message:" + message.getId() + ":" + delivery.getId(),
                        deliveryPrompt(message, source, target));
                delivery.markDispatched(receipt.queuedSubmissionId(), receipt.turnId());
            }
            deliveryRepository.save(delivery);
        } catch (RuntimeException error) {
            delivery.markFailed(safeMessage(error));
            deliveryRepository.save(delivery);
        }
    }

    private String runtimeSessionId(AgentEntity agent) {
        String sessionId = agent.getRuntimeSessionId();
        return sessionId == null || sessionId.isBlank() ? agent.getCodexThreadId() : sessionId;
    }

    private void updateAggregate(AgentMessageEntity message, List<AgentMessageDeliveryEntity> deliveries) {
        if (deliveries.isEmpty()) {
            message.markFailed("Message has no deliveries");
            return;
        }
        long completed = deliveries.stream().filter(d -> d.getStatus() == AgentMessageStatus.COMPLETED).count();
        long failed = deliveries.stream().filter(d -> d.getStatus() == AgentMessageStatus.FAILED).count();
        long processing = deliveries.stream().filter(d -> d.getStatus() == AgentMessageStatus.PROCESSING).count();
        long dispatched = deliveries.stream().filter(d -> d.getStatus() == AgentMessageStatus.DISPATCHED).count();
        long queued = deliveries.stream().filter(d -> d.getStatus() == AgentMessageStatus.QUEUED).count();
        boolean terminal = completed + failed == deliveries.size();

        if (terminal && completed == deliveries.size()) {
            message.markCompleted();
        } else if (terminal && failed == deliveries.size()) {
            message.markFailed("All message deliveries failed");
        } else if (terminal) {
            message.markPartial(failed + " of " + deliveries.size() + " message deliveries failed");
        } else if (processing > 0 || completed > 0) {
            String turnId = deliveries.stream().map(AgentMessageDeliveryEntity::getCodexTurnId)
                    .filter(value -> value != null && !value.isBlank()).findFirst().orElse(null);
            message.markProcessing(turnId);
        } else if (dispatched > 0) {
            AgentMessageDeliveryEntity first = deliveries.stream()
                    .filter(d -> d.getStatus() == AgentMessageStatus.DISPATCHED).findFirst().orElse(deliveries.get(0));
            message.markDispatched(first.getCodexQueuedSubmissionId(), first.getCodexTurnId());
        } else if (queued > 0) {
            AgentMessageDeliveryEntity first = deliveries.stream()
                    .filter(d -> d.getStatus() == AgentMessageStatus.QUEUED).findFirst().orElse(deliveries.get(0));
            message.markQueued(first.getCodexQueuedSubmissionId());
        } else {
            message.markCreated();
        }
    }

    private String audienceSpec(AgentMessageAudienceType type, AudienceRequest audience, List<AgentEntity> recipients) {
        try {
            ObjectNode spec = mapper.createObjectNode();
            spec.put("type", type.name());
            if (audience != null && audience.role() != null) spec.put("role", audience.role().name());
            if (audience != null && audience.groupId() != null) spec.put("groupId", audience.groupId().toString());
            ArrayNode resolved = spec.putArray("resolvedRecipientIds");
            recipients.forEach(agent -> resolved.add(agent.getId().toString()));
            return mapper.writeValueAsString(spec);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to serialize message audience", error);
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
                Audience: %s
                Type: %s
                Subject: %s
                Hop: %d/%d

                Message:
                %s

                Treat this as inter-agent communication, not as a new user requirement unless the message asks for work.
                Replies are direct to the sender by default. If a response is necessary, use agenticform.send_message and set replyToMessageId to %s.
                Do not broadcast or reply-all merely to acknowledge a message.
                """.formatted(
                message.getId(), message.getConversationId(), source.getName(), source.getId(),
                target.getName(), target.getId(), message.getAudienceType(), message.getType(), message.getSubject(),
                message.getHopCount(), MAX_HOPS, message.getContent(), message.getId());
    }

    private String normalize(String value, String field, int max) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Message " + field + " is required");
        String normalized = value.trim();
        if (normalized.length() > max) throw new IllegalArgumentException("Message " + field + " is too long");
        return normalized;
    }

    private String safeMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) return error.getClass().getSimpleName();
        return message.length() > 1000 ? message.substring(0, 1000) : message;
    }
}
