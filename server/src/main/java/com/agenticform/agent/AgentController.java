package com.agenticform.agent;

import com.agenticform.node.NodeTrustLevel;
import com.agenticform.runtime.RuntimeType;
import com.agenticform.workspace.WorkspaceMode;
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
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/agents")
public class AgentController {
    private final AgentService service;
    private final AgentRuntimeRecoveryService recovery;
    private final AgentLifecycleService lifecycle;
    private final AgentStreamService stream;

    public AgentController(AgentService service, AgentRuntimeRecoveryService recovery,
                           AgentLifecycleService lifecycle, AgentStreamService stream) {
        this.service = service;
        this.recovery = recovery;
        this.lifecycle = lifecycle;
        this.stream = stream;
    }

    @GetMapping
    public List<AgentEntity> list(@RequestParam(required = false) UUID projectId) {
        return service.list(projectId);
    }

    @GetMapping(value = "/stream", produces = "text/event-stream")
    public SseEmitter stream() {
        return stream.subscribe();
    }

    @GetMapping("/templates")
    public List<AgentTemplateResponse> templates() {
        return AgentTemplate.all().stream()
                .map(template -> new AgentTemplateResponse(template.getId(), template.getDisplayName(),
                        template.getResponsibility(), template.getCapabilityProfile()))
                .toList();
    }

    @PostMapping
    public AgentEntity spawn(@Valid @RequestBody SpawnAgentRequest request) {
        return service.spawn(new AgentService.SpawnAgent(
                request.projectId(), request.name(), request.responsibility(), request.workspaceMode(),
                request.baseBranch(), request.branch(), request.queueMode(), request.humanControlMode(),
                request.executionNodeId(), request.minimumTrust(), request.capabilityProfile(), request.runtimeType(), request.runtimeProfileId(), request.templateId()));
    }

    @PostMapping("/operational/ensure")
    public AgentEntity ensureOperational(@Valid @RequestBody EnsureOperationalAgentRequest request) {
        return service.ensureOperationalAgent(request.projectId());
    }

    @PostMapping("/{agentId}/human-control-mode")
    public AgentEntity updateHumanControlMode(@PathVariable UUID agentId,
                                              @Valid @RequestBody HumanControlModeRequest request) {
        return service.updateHumanControlMode(agentId, request.mode());
    }

    @PostMapping("/{agentId}/queue-mode")
    public AgentEntity updateQueueMode(@PathVariable UUID agentId,
                                       @Valid @RequestBody QueueModeRequest request) {
        return service.updateQueueMode(agentId, request.mode());
    }

    @PostMapping("/{agentId}/intervene")
    public AgentEntity intervene(@PathVariable UUID agentId) {
        return service.intervene(agentId);
    }

    @PostMapping("/{agentId}/stop")
    public AgentEntity stop(@PathVariable UUID agentId) {
        return lifecycle.stop(agentId);
    }

    @PostMapping("/{agentId}/recover-runtime")
    public AgentEntity recoverRuntime(@PathVariable UUID agentId) {
        return recovery.recover(agentId);
    }

    @PostMapping("/{agentId}/restart-runtime")
    public AgentEntity restartRuntime(@PathVariable UUID agentId) {
        return recovery.restart(agentId);
    }

    @PostMapping("/{agentId}/cleanup-runtime")
    public AgentEntity cleanupRuntime(@PathVariable UUID agentId) {
        return recovery.cleanup(agentId);
    }

    public record SpawnAgentRequest(
            @NotNull UUID projectId,
            @NotBlank String name,
            @NotBlank String responsibility,
            WorkspaceMode workspaceMode,
            String baseBranch,
            String branch,
            AgentQueueMode queueMode,
            HumanControlMode humanControlMode,
            UUID executionNodeId,
            NodeTrustLevel minimumTrust,
            AgentCapabilityProfile capabilityProfile,
            @NotNull RuntimeType runtimeType,
            String runtimeProfileId,
            String templateId
    ) {}

    public record EnsureOperationalAgentRequest(@NotNull UUID projectId) {}
    public record HumanControlModeRequest(@NotNull HumanControlMode mode) {}
    public record QueueModeRequest(@NotNull AgentQueueMode mode) {}
    public record AgentTemplateResponse(String id, String displayName, String responsibility,
                                        AgentCapabilityProfile capabilityProfile) {}
}
