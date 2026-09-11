package com.agenticform.task;

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
@RequestMapping("/api/tasks")
public class TaskController {
    private final TaskDispatchService service;

    public TaskController(TaskDispatchService service) {
        this.service = service;
    }

    @GetMapping
    public List<TaskEntity> list(@RequestParam(required = false) UUID projectId) {
        return service.list(projectId);
    }

    @PostMapping
    public TaskEntity create(@Valid @RequestBody CreateTaskRequest request) {
        return service.create(request.agentId(), request.title(), request.prompt(), request.priority());
    }

    @PostMapping("/{taskId}/dispatch")
    public TaskEntity dispatch(@PathVariable UUID taskId) {
        return service.dispatchManually(taskId);
    }

    public record CreateTaskRequest(
            @NotNull UUID agentId,
            @NotBlank String title,
            @NotBlank String prompt,
            int priority
    ) {}
}
