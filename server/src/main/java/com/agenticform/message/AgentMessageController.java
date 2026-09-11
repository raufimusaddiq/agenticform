package com.agenticform.message;

import com.agenticform.agent.AgentRole;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/messages")
public class AgentMessageController {
    private final AgentMessageService service;

    public AgentMessageController(AgentMessageService service) {
        this.service = service;
    }

    @GetMapping
    public List<AgentMessageEntity> list(@RequestParam(required = false) UUID projectId,
                                         @RequestParam(required = false) UUID agentId) {
        return service.list(projectId, agentId);
    }

    @GetMapping("/conversations/{conversationId}")
    public List<AgentMessageEntity> conversation(@PathVariable UUID conversationId) {
        return service.conversation(conversationId);
    }

    @GetMapping("/{messageId}/deliveries")
    public List<AgentMessageDeliveryEntity> deliveries(@PathVariable UUID messageId) {
        return service.deliveries(messageId);
    }

    @PostMapping
    public AgentMessageEntity send(@Valid @RequestBody SendMessageRequest request) {
        return service.send(request.fromAgentId(), request.toAgentId(), request.type(),
                request.subject(), request.content(), request.replyToMessageId());
    }

    @PostMapping("/audience")
    public AgentMessageService.SendResult sendAudience(@Valid @RequestBody SendAudienceMessageRequest request) {
        return service.sendAudience(request.fromAgentId(), new AgentMessageService.AudienceRequest(
                        request.audienceType(), request.agentIds(), request.role(), request.groupId()),
                request.type(), request.subject(), request.content(), request.replyToMessageId());
    }

    @PostMapping("/{messageId}/retry")
    public AgentMessageService.SendResult retry(@PathVariable UUID messageId) {
        return service.retry(messageId);
    }

    public record SendMessageRequest(
            @NotNull UUID fromAgentId,
            @NotNull UUID toAgentId,
            AgentMessageType type,
            @NotBlank String subject,
            @NotBlank String content,
            UUID replyToMessageId
    ) {}

    public record SendAudienceMessageRequest(
            @NotNull UUID fromAgentId,
            @NotNull AgentMessageAudienceType audienceType,
            List<UUID> agentIds,
            AgentRole role,
            UUID groupId,
            AgentMessageType type,
            @NotBlank String subject,
            @NotBlank String content,
            UUID replyToMessageId
    ) {}
}
