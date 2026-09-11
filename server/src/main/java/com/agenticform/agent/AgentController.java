package com.agenticform.agent;

import com.agenticform.workspace.WorkspaceMode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/agents")
public class AgentController {
    private final AgentService service;

    public AgentController(AgentService service) {
        this.service = service;
    }

    @GetMapping
    public List<AgentEntity> list(@RequestParam(required = false) UUID projectId) {
        return service.list(projectId);
    }

    @PostMapping
    public AgentEntity spawn(@Valid @RequestBody SpawnAgentRequest request) {
        return service.spawn(new AgentService.SpawnAgent(
                request.projectId(), request.name(), request.responsibility(), request.workspaceMode(),
                request.baseBranch(), request.branch(), request.queueMode()));
    }

    public record SpawnAgentRequest(
            @NotNull UUID projectId,
            @NotBlank String name,
            @NotBlank String responsibility,
            WorkspaceMode workspaceMode,
            String baseBranch,
            String branch,
            AgentQueueMode queueMode
    ) {}
}
