package com.agenticform.message;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/communication-rules")
public class CommunicationRuleController {
    private final CommunicationRuleService service;

    public CommunicationRuleController(CommunicationRuleService service) {
        this.service = service;
    }

    @GetMapping
    public List<CommunicationRuleEntity> list() {
        return service.list();
    }

    @PutMapping
    public CommunicationRuleEntity upsert(@Valid @RequestBody UpsertRequest request) {
        return service.upsert(request.fromProjectId(), request.toProjectId(), request.action(),
                request.effect(), request.enabled());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable UUID id) {
        service.delete(id);
        return ResponseEntity.noContent().build();
    }

    public record UpsertRequest(@NotNull UUID fromProjectId,
                                @NotNull UUID toProjectId,
                                CommunicationRuleEntity.Action action,
                                @NotNull CommunicationRuleEntity.Effect effect,
                                boolean enabled) {}
}
