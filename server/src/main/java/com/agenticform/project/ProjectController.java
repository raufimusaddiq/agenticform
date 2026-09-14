package com.agenticform.project;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/projects")
public class ProjectController {
    private final ProjectService service;
    private final ProjectDiscoveryService discovery;

    public ProjectController(ProjectService service, ProjectDiscoveryService discovery) {
        this.service = service;
        this.discovery = discovery;
    }

    @GetMapping
    public List<ProjectEntity> list() {
        return service.list();
    }

    @GetMapping("/discover")
    public List<ProjectDiscoveryService.Candidate> discover() {
        return discovery.discover();
    }

    @PostMapping
    public ProjectEntity register(@Valid @RequestBody RegisterProjectRequest request) {
        return service.register(request.name(), request.sourceType(), request.path(),
                request.repositoryUrl(), request.defaultBranch(), request.githubToken());
    }

    @GetMapping("/{projectId}")
    public ProjectEntity get(@PathVariable UUID projectId) { return service.get(projectId); }

    @PatchMapping("/{projectId}")
    public ProjectEntity update(@PathVariable UUID projectId, @Valid @RequestBody UpdateProjectRequest request) {
        return service.update(projectId, request.name(), request.defaultBranch(), request.enabled(), request.githubToken());
    }

    public record RegisterProjectRequest(
            @NotBlank String name,
            ProjectSourceType sourceType,
            String path,
            String repositoryUrl,
            @NotBlank String defaultBranch,
            String githubToken
    ) {}

    public record UpdateProjectRequest(
            @NotBlank String name,
            @NotBlank String defaultBranch,
            boolean enabled,
            String githubToken
    ) {}
}
