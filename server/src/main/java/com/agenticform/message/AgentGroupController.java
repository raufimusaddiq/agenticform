package com.agenticform.message;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/agent-groups")
public class AgentGroupController {
    private final AgentGroupService service;

    public AgentGroupController(AgentGroupService service) {
        this.service = service;
    }

    @GetMapping
    public List<AgentGroupService.GroupDetail> list(@RequestParam @NotNull UUID projectId) {
        return service.list(projectId);
    }

    @PostMapping
    public AgentGroupService.GroupDetail create(@Valid @RequestBody CreateGroupRequest request) {
        return service.create(request.projectId(), request.name(), request.memberAgentIds());
    }

    @PutMapping("/{groupId}/members")
    public AgentGroupService.GroupDetail replaceMembers(@PathVariable UUID groupId,
                                                         @Valid @RequestBody ReplaceMembersRequest request) {
        return service.replaceMembers(groupId, request.memberAgentIds());
    }

    @DeleteMapping("/{groupId}")
    public void delete(@PathVariable UUID groupId) {
        service.delete(groupId);
    }

    public record CreateGroupRequest(@NotNull UUID projectId, @NotBlank String name,
                                     List<UUID> memberAgentIds) {}
    public record ReplaceMembersRequest(List<UUID> memberAgentIds) {}
}
