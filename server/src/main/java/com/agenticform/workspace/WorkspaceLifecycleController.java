package com.agenticform.workspace;

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
@RequestMapping("/api/workspaces")
public class WorkspaceLifecycleController {
    private final WorkspaceLifecycleService service;

    public WorkspaceLifecycleController(WorkspaceLifecycleService service) {
        this.service = service;
    }

    @GetMapping("/agents/{agentId}/cleanup-inspection")
    public WorkspaceLifecycleService.Inspection inspect(@PathVariable UUID agentId) {
        return service.inspect(agentId);
    }

    @PostMapping("/agents/{agentId}/cleanup")
    public WorkspaceCleanupRecordEntity cleanup(@PathVariable UUID agentId,
                                                @RequestBody(required = false) CleanupRequest request) {
        return service.cleanup(agentId, request == null ? null : request.reason());
    }

    @GetMapping("/cleanup-history")
    public List<WorkspaceCleanupRecordEntity> history(@RequestParam(required = false) UUID projectId) {
        return service.history(projectId);
    }

    public record CleanupRequest(String reason) {}
}
