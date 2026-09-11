package com.agenticform.policy;

import com.agenticform.agent.AgentRepository;
import com.agenticform.project.ProjectRepository;
import com.agenticform.task.TaskRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

@Service
public class PolicyRuleService {
    private final PolicyRuleRepository repository;
    private final ProjectRepository projectRepository;
    private final AgentRepository agentRepository;
    private final TaskRepository taskRepository;
    private final DeterministicPolicyEngine engine;

    public PolicyRuleService(PolicyRuleRepository repository,
                             ProjectRepository projectRepository,
                             AgentRepository agentRepository,
                             TaskRepository taskRepository,
                             DeterministicPolicyEngine engine) {
        this.repository = repository;
        this.projectRepository = projectRepository;
        this.agentRepository = agentRepository;
        this.taskRepository = taskRepository;
        this.engine = engine;
    }

    public List<PolicyRuleEntity> list() {
        return repository.findAllByOrderByScopeTypeAscActionAscEnvironmentAsc();
    }

    public List<PolicyRuleEntity> applicable(UUID projectId, UUID agentId, UUID taskId) {
        return repository.findAllByEnabledTrue().stream()
                .filter(rule -> switch (rule.getScopeType()) {
                    case GLOBAL -> true;
                    case PROJECT -> rule.getScopeId().equals(projectId);
                    case AGENT -> rule.getScopeId().equals(agentId);
                    case TASK -> taskId != null && rule.getScopeId().equals(taskId);
                })
                .toList();
    }

    @Transactional
    public PolicyRuleEntity create(PolicyScopeType scopeType, UUID scopeId, String action, String environment,
                                   PolicyEffect effect, String description, boolean enabled) {
        NormalizedRule normalized = normalize(scopeType, scopeId, action, environment, effect, description, enabled);
        rejectDuplicate(null, normalized);
        return repository.save(new PolicyRuleEntity(normalized.scopeType(), normalized.scopeId(),
                normalized.action(), normalized.environment(), normalized.effect(), normalized.description(), normalized.enabled()));
    }

    @Transactional
    public PolicyRuleEntity update(UUID id, PolicyScopeType scopeType, UUID scopeId, String action,
                                   String environment, PolicyEffect effect, String description, boolean enabled) {
        PolicyRuleEntity rule = repository.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Policy rule not found: " + id));
        NormalizedRule normalized = normalize(scopeType, scopeId, action, environment, effect, description, enabled);
        if (isGlobalFallback(rule) && !isGlobalFallback(normalized)) {
            throw new IllegalStateException("The global */* fallback rule cannot be repurposed; change its effect instead");
        }
        if (isGlobalFallback(rule) && !enabled) {
            throw new IllegalStateException("The global */* fallback rule must remain enabled");
        }
        rejectDuplicate(id, normalized);
        rule.update(normalized.scopeType(), normalized.scopeId(), normalized.action(), normalized.environment(),
                normalized.effect(), normalized.description(), normalized.enabled());
        return repository.save(rule);
    }

    @Transactional
    public void delete(UUID id) {
        PolicyRuleEntity rule = repository.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Policy rule not found: " + id));
        if (isGlobalFallback(rule)) {
            throw new IllegalStateException("The global */* fallback rule cannot be deleted");
        }
        repository.delete(rule);
    }

    private NormalizedRule normalize(PolicyScopeType scopeType, UUID scopeId, String action, String environment,
                                     PolicyEffect effect, String description, boolean enabled) {
        if (scopeType == null) throw new IllegalArgumentException("scopeType is required");
        if (effect == null) throw new IllegalArgumentException("effect is required");
        if (scopeType == PolicyScopeType.GLOBAL) {
            scopeId = null;
        } else if (scopeId == null) {
            throw new IllegalArgumentException("scopeId is required for " + scopeType);
        }
        validateScope(scopeType, scopeId);
        String normalizedAction = engine.normalizeAction(action);
        String normalizedEnvironment = engine.normalizeEnvironment(environment);
        if (normalizedAction.length() > 128) throw new IllegalArgumentException("action is too long");
        if (normalizedEnvironment.length() > 64) throw new IllegalArgumentException("environment is too long");
        String normalizedDescription = description == null || description.isBlank()
                ? normalizedAction + " / " + normalizedEnvironment : description.trim();
        return new NormalizedRule(scopeType, scopeId, normalizedAction, normalizedEnvironment,
                effect, normalizedDescription, enabled);
    }

    private void validateScope(PolicyScopeType scopeType, UUID scopeId) {
        if (scopeType == PolicyScopeType.GLOBAL) return;
        boolean exists = switch (scopeType) {
            case PROJECT -> projectRepository.existsById(scopeId);
            case AGENT -> agentRepository.existsById(scopeId);
            case TASK -> taskRepository.existsById(scopeId);
            case GLOBAL -> true;
        };
        if (!exists) throw new IllegalArgumentException("Policy scope target does not exist: " + scopeType + " " + scopeId);
    }

    private void rejectDuplicate(UUID currentId, NormalizedRule candidate) {
        boolean duplicate = repository.findAll().stream().anyMatch(rule ->
                !rule.getId().equals(currentId)
                        && rule.getScopeType() == candidate.scopeType()
                        && java.util.Objects.equals(rule.getScopeId(), candidate.scopeId())
                        && rule.getAction().equals(candidate.action())
                        && rule.getEnvironment().equals(candidate.environment()));
        if (duplicate) {
            throw new IllegalStateException("A policy rule already exists for this exact scope/action/environment");
        }
    }

    private boolean isGlobalFallback(PolicyRuleEntity rule) {
        return rule.getScopeType() == PolicyScopeType.GLOBAL
                && rule.getScopeId() == null
                && "*".equals(rule.getAction())
                && "*".equals(rule.getEnvironment());
    }

    private boolean isGlobalFallback(NormalizedRule rule) {
        return rule.scopeType() == PolicyScopeType.GLOBAL
                && rule.scopeId() == null
                && "*".equals(rule.action())
                && "*".equals(rule.environment());
    }

    private record NormalizedRule(PolicyScopeType scopeType, UUID scopeId, String action, String environment,
                                  PolicyEffect effect, String description, boolean enabled) {}
}
