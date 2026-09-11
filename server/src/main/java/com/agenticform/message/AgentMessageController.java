package com.agenticform.message;

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

    @PostMapping
    public AgentMessageEntity send(@Valid @RequestBody SendMessageRequest request) {
        return service.send(request.fromAgentId(), request.toAgentId(), request.type(),
                request.subject(), request.content(), request.replyToMessageId());
    }

    public record SendMessageRequest(
            @NotNull UUID fromAgentId,
            @NotNull UUID toAgentId,
            AgentMessageType type,
            @NotBlank String subject,
            @NotBlank String content,
            UUID replyToMessageId
    ) {}
}
