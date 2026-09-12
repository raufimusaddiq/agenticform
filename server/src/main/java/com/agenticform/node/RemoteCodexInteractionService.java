package com.agenticform.node;

import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.AgentRepository;
import com.agenticform.codex.CodexJsonRpcClient;
import com.agenticform.codex.CodexServerRequestRouter;
import com.agenticform.runtime.RuntimeType;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class RemoteCodexInteractionService implements RemoteInteractionService {
    public record InteractionView(UUID id, RemoteCodexInteractionEntity.Status status,
                                  String responseJson, String error) {}

    private final RemoteCodexInteractionRepository repository;
    private final AgentRepository agents;
    private final CodexServerRequestRouter router;
    private final RemoteInteractionContext context;
    private final ObjectMapper mapper;

    public RemoteCodexInteractionService(RemoteCodexInteractionRepository repository,
                                         AgentRepository agents,
                                         CodexServerRequestRouter router,
                                         RemoteInteractionContext context,
                                         ObjectMapper mapper) {
        this.repository = repository;
        this.agents = agents;
        this.router = router;
        this.context = context;
        this.mapper = mapper;
    }

    public InteractionView begin(UUID nodeId, long runtimeGeneration, RuntimeType runtimeType,
                                 String runtimeSessionId,
                                 CodexJsonRpcClient.ServerRequest request) {
        AgentEntity agent = requireRuntime(nodeId, runtimeGeneration, runtimeType, runtimeSessionId);
        String requestId = requestId(request.id());
        var existing = repository.findByNodeIdAndAgentIdAndRuntimeGenerationAndCodexRequestId(
                nodeId, agent.getId(), runtimeGeneration, requestId);
        if (existing.isPresent()) return view(existing.get());

        RemoteCodexInteractionEntity interaction = repository.save(new RemoteCodexInteractionEntity(
                nodeId, agent.getId(), runtimeGeneration, runtimeType, runtimeSessionId,
                requestId, request.method(), toJson(request.params())));
        try {
            context.within(interaction.getId(), () -> {
                router.route(request).whenComplete((result, error) -> {
                    if (error != null) fail(interaction.getId(), safeError(error));
                    else ready(interaction.getId(), result);
                });
                return null;
            });
        } catch (RuntimeException error) {
            fail(interaction.getId(), safeError(error));
        }
        return repository.findById(interaction.getId()).map(this::view).orElseThrow();
    }

    public InteractionView poll(UUID nodeId, UUID interactionId) {
        RemoteCodexInteractionEntity interaction = getForNode(nodeId, interactionId);
        requireCurrentGeneration(interaction);
        return view(interaction);
    }

    public synchronized InteractionView acknowledge(UUID nodeId, UUID interactionId) {
        RemoteCodexInteractionEntity interaction = getForNode(nodeId, interactionId);
        requireCurrentGeneration(interaction);
        if (interaction.getStatus() == RemoteCodexInteractionEntity.Status.CONSUMED) return view(interaction);
        interaction.consumed();
        return view(repository.save(interaction));
    }

    public synchronized void ready(UUID interactionId, JsonNode result) {
        repository.findById(interactionId).ifPresent(interaction -> {
            if (interaction.getStatus() == RemoteCodexInteractionEntity.Status.CONSUMED) return;
            interaction.ready(toJson(result));
            repository.save(interaction);
        });
    }

    public synchronized void fail(UUID interactionId, String error) {
        repository.findById(interactionId).ifPresent(interaction -> {
            if (interaction.getStatus() == RemoteCodexInteractionEntity.Status.CONSUMED) return;
            interaction.fail(error);
            repository.save(interaction);
        });
    }

    public AgentEntity requireRuntime(UUID nodeId, long generation, RuntimeType runtimeType, String sessionId) {
        if (runtimeType == null || sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException("Remote request requires runtimeType and runtimeSessionId");
        }
        AgentEntity agent = agents.findByRuntimeTypeAndRuntimeSessionId(runtimeType, sessionId)
                .orElseThrow(() -> new NoSuchElementException("No Agenticform agent owns runtime session " + sessionId));
        if (!agent.ownsRuntime(nodeId, generation, runtimeType, sessionId)) {
            throw new IllegalStateException("Remote Codex request belongs to a stale runtime generation");
        }
        return agent;
    }

    private void requireCurrentGeneration(RemoteCodexInteractionEntity interaction) {
        AgentEntity agent = agents.findById(interaction.getAgentId())
                .orElseThrow(() -> new NoSuchElementException("Agent not found: " + interaction.getAgentId()));
        if (!agent.ownsRuntime(interaction.getNodeId(), interaction.getRuntimeGeneration(),
                interaction.getRuntimeType(), interaction.getRuntimeSessionId())) {
            throw new IllegalStateException("Remote Codex interaction belongs to a stale runtime generation");
        }
    }

    private RemoteCodexInteractionEntity getForNode(UUID nodeId, UUID interactionId) {
        RemoteCodexInteractionEntity interaction = repository.findById(interactionId)
                .orElseThrow(() -> new NoSuchElementException("Remote Codex interaction not found: " + interactionId));
        if (!nodeId.equals(interaction.getNodeId())) {
            throw new IllegalArgumentException("Remote Codex interaction belongs to another node");
        }
        return interaction;
    }

    private InteractionView view(RemoteCodexInteractionEntity interaction) {
        return new InteractionView(interaction.getId(), interaction.getStatus(),
                interaction.getResponseJson(), interaction.getLastError());
    }

    private String requestId(JsonNode id) {
        return id == null ? "0" : id.isTextual() ? id.asText() : id.toString();
    }

    private String toJson(JsonNode value) {
        try {
            return mapper.writeValueAsString(value == null ? mapper.createObjectNode() : value);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to serialize remote Codex interaction", error);
        }
    }

    private String safeError(Throwable error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        String message = cause.getMessage();
        if (message == null || message.isBlank()) message = cause.getClass().getSimpleName();
        return message.length() > 1000 ? message.substring(0, 1000) : message;
    }
}
