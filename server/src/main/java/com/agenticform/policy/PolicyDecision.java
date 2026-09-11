package com.agenticform.policy;

import java.util.UUID;

public record PolicyDecision(
        PolicyEffect effect,
        UUID matchedRuleId,
        PolicyScopeType matchedScopeType,
        UUID matchedScopeId,
        String action,
        String environment,
        String description
) {}
