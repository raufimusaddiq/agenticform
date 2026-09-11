package com.agenticform.policy;

import org.springframework.stereotype.Service;

import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

@Service
public class DeterministicPolicyEngine {
    private final PolicyRuleRepository repository;

    public DeterministicPolicyEngine(PolicyRuleRepository repository) {
        this.repository = repository;
    }

    public PolicyDecision evaluate(PolicyContext rawContext) {
        PolicyContext context = normalize(rawContext);
        List<PolicyRuleEntity> candidates = repository.findAllByEnabledTrue().stream()
                .filter(rule -> scopeMatches(rule, context))
                .filter(rule -> matcherMatches(rule, context))
                .sorted(ruleOrder(context))
                .toList();

        if (candidates.isEmpty()) {
            throw new IllegalStateException("No policy rule matched action=" + context.action()
                    + " environment=" + context.environment() + "; a global wildcard rule is required");
        }

        PolicyRuleEntity winner = candidates.get(0);
        return new PolicyDecision(
                winner.getEffect(),
                winner.getId(),
                winner.getScopeType(),
                winner.getScopeId(),
                context.action(),
                context.environment(),
                winner.getDescription()
        );
    }

    private Comparator<PolicyRuleEntity> ruleOrder(PolicyContext context) {
        return Comparator
                .comparingInt((PolicyRuleEntity rule) -> scopeRank(rule.getScopeType())).reversed()
                .thenComparingInt(rule -> actionSpecificity(rule, context)).reversed()
                .thenComparingInt(rule -> environmentSpecificity(rule, context)).reversed()
                .thenComparing(rule -> rule.getId().toString());
    }

    private int scopeRank(PolicyScopeType type) {
        return switch (type) {
            case GLOBAL -> 0;
            case PROJECT -> 1;
            case AGENT -> 2;
            case TASK -> 3;
        };
    }

    private int actionSpecificity(PolicyRuleEntity rule, PolicyContext context) {
        return rule.getAction().equals(context.action()) ? 1 : 0;
    }

    private int environmentSpecificity(PolicyRuleEntity rule, PolicyContext context) {
        return rule.getEnvironment().equals(context.environment()) ? 1 : 0;
    }

    private boolean scopeMatches(PolicyRuleEntity rule, PolicyContext context) {
        return switch (rule.getScopeType()) {
            case GLOBAL -> rule.getScopeId() == null;
            case PROJECT -> equals(rule.getScopeId(), context.projectId());
            case AGENT -> equals(rule.getScopeId(), context.agentId());
            case TASK -> equals(rule.getScopeId(), context.taskId());
        };
    }

    private boolean matcherMatches(PolicyRuleEntity rule, PolicyContext context) {
        boolean action = "*".equals(rule.getAction()) || rule.getAction().equals(context.action());
        boolean environment = "*".equals(rule.getEnvironment()) || rule.getEnvironment().equals(context.environment());
        return action && environment;
    }

    private boolean equals(UUID left, UUID right) {
        return left != null && left.equals(right);
    }

    public PolicyContext normalize(PolicyContext context) {
        if (context == null) throw new IllegalArgumentException("Policy context is required");
        String action = normalizeAction(context.action());
        String environment = normalizeEnvironment(context.environment());
        return new PolicyContext(context.projectId(), context.agentId(), context.taskId(), action, environment);
    }

    public String normalizeAction(String action) {
        if (action == null || action.isBlank()) return "*";
        return action.trim().toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
    }

    public String normalizeEnvironment(String environment) {
        if (environment == null || environment.isBlank()) return "*";
        return environment.trim().toLowerCase(Locale.ROOT);
    }
}
