package com.agenticform.policy;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/policies")
public class PolicyController {
    private final PolicyRuleService ruleService;
    private final DeterministicPolicyEngine engine;

    public PolicyController(PolicyRuleService ruleService, DeterministicPolicyEngine engine) {
        this.ruleService = ruleService;
        this.engine = engine;
    }

    @GetMapping("/rules")
    public List<PolicyRuleEntity> rules() {
        return ruleService.list();
    }

    @PostMapping("/rules")
    @ResponseStatus(HttpStatus.CREATED)
    public PolicyRuleEntity create(@Valid @RequestBody RuleRequest request) {
        return ruleService.create(request.scopeType(), request.scopeId(), request.action(), request.environment(),
                request.effect(), request.description(), request.enabled());
    }

    @PutMapping("/rules/{id}")
    public PolicyRuleEntity update(@PathVariable UUID id, @Valid @RequestBody RuleRequest request) {
        return ruleService.update(id, request.scopeType(), request.scopeId(), request.action(), request.environment(),
                request.effect(), request.description(), request.enabled());
    }

    @DeleteMapping("/rules/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        ruleService.delete(id);
    }

    @PostMapping("/evaluate")
    public PolicyDecision evaluate(@Valid @RequestBody EvaluateRequest request) {
        return engine.evaluate(new PolicyContext(request.projectId(), request.agentId(), request.taskId(),
                request.action(), request.environment()));
    }

    public record RuleRequest(
            @NotNull PolicyScopeType scopeType,
            UUID scopeId,
            @NotBlank String action,
            String environment,
            @NotNull PolicyEffect effect,
            String description,
            boolean enabled
    ) {}

    public record EvaluateRequest(
            UUID projectId,
            UUID agentId,
            UUID taskId,
            @NotBlank String action,
            String environment
    ) {}
}
