package com.agenticform.task;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.DeleteMapping;
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
@RequestMapping("/api/tasks")
public class TaskController {
    private final TaskDispatchService service;
    private final TaskDependencyService dependencies;

    public TaskController(TaskDispatchService service, TaskDependencyService dependencies) {
        this.service = service;
        this.dependencies = dependencies;
    }

    @GetMapping
    public List<TaskEntity> list(@RequestParam(name = "projectId", required = false) UUID projectId) {
        return service.list(projectId);
    }

    @PostMapping
    public TaskEntity create(@Valid @RequestBody CreateTaskRequest request) {
        List<TaskDependencyService.DependencyRequest> dependencyRequests = request.dependencies() == null
                ? List.of()
                : request.dependencies().stream()
                .map(dep -> new TaskDependencyService.DependencyRequest(dep.dependsOnTaskId(), dep.type()))
                .toList();
        return service.create(request.agentId(), request.title(), request.prompt(), request.priority(), dependencyRequests, null, request.kind());
    }

    @PostMapping("/{taskId}/dispatch")
    public TaskEntity dispatch(@PathVariable UUID taskId) {
        return service.dispatchManually(taskId);
    }

    @GetMapping("/{taskId}/dependencies")
    public List<TaskDependencyEntity> dependencies(@PathVariable UUID taskId) {
        return dependencies.list(taskId);
    }

    @PostMapping("/{taskId}/dependencies")
    public TaskDependencyEntity addDependency(@PathVariable UUID taskId,
                                               @Valid @RequestBody DependencyRequest request) {
        return dependencies.add(taskId, request.dependsOnTaskId(), request.type());
    }

    @DeleteMapping("/{taskId}/dependencies/{dependsOnTaskId}")
    public void removeDependency(@PathVariable UUID taskId, @PathVariable UUID dependsOnTaskId) {
        dependencies.remove(taskId, dependsOnTaskId);
    }

    public record CreateTaskRequest(
            @NotNull UUID agentId,
            @NotBlank String title,
            @NotBlank String prompt,
            int priority,
            List<DependencyRequest> dependencies,
            TaskKind kind
    ) {}

    public record DependencyRequest(@NotNull UUID dependsOnTaskId, TaskDependencyType type) {}
}
