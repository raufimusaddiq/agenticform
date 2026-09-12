package com.agenticform.approval;

import com.agenticform.agent.AgentCapabilityPolicy;
import com.agenticform.agent.AgentCapabilityProfile;
import com.agenticform.agent.AgentEntity;
import com.agenticform.agent.HumanControlMode;
import com.agenticform.policy.DeterministicPolicyEngine;
import com.agenticform.policy.PolicyActionClassifier;
import com.agenticform.policy.PolicyContext;
import com.agenticform.policy.PolicyDecision;
import com.agenticform.policy.PolicyEffect;
import com.agenticform.policy.PolicyEffectFingerprint;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

@Component
public class HumanApprovalPolicy {
    private final PolicyActionClassifier classifier;
    private final DeterministicPolicyEngine engine;
    private final AgentCapabilityPolicy capabilityPolicy;

    public HumanApprovalPolicy(PolicyActionClassifier classifier, DeterministicPolicyEngine engine,
                               AgentCapabilityPolicy capabilityPolicy) {
        this.classifier = classifier;
        this.engine = engine;
        this.capabilityPolicy = capabilityPolicy;
    }

    public Evaluation evaluate(AgentEntity agent, HumanApprovalType type, JsonNode params) {
        return evaluateClassified(agent, type, classifier.classify(type, params), params);
    }

    public Evaluation evaluateDeclaredAction(AgentEntity agent, JsonNode arguments) {
        return evaluateClassified(agent, HumanApprovalType.PROTECTED_ACTION,
                classifier.declaredAction(arguments), arguments);
    }

    private Evaluation evaluateClassified(AgentEntity agent, HumanApprovalType type,
                                          PolicyActionClassifier.ClassifiedAction classified,
                                          JsonNode params) {
        PolicyDecision configured = engine.evaluate(new PolicyContext(
                agent.getProjectId(), agent.getId(), agent.getActiveTaskId(),
                classified.action(), classified.environment()));

        AgentCapabilityProfile.Capability requiredCapability = capabilityPolicy.requiredForApproval(
                type, classified.action(), params);
        boolean capabilityAllowed = capabilityPolicy.allows(agent, requiredCapability);
        PolicyEffect effectiveEffect = capabilityAllowed ? configured.effect() : PolicyEffect.DENY;
        if (capabilityAllowed
                && agent.getHumanControlMode() == HumanControlMode.IN_THE_LOOP
                && effectiveEffect == PolicyEffect.ALLOW) {
            effectiveEffect = PolicyEffect.REQUIRE_HUMAN;
        }

        HumanApprovalRisk risk = risk(classified.action(), type, effectiveEffect);
        String effectDigest = PolicyEffectFingerprint.digest(
                classified.action(), classified.environment(), classified.effectKey());
        String summary = capabilityAllowed
                ? classified.summary()
                : "Capability profile " + agent.getCapabilityProfile() + " denies " + requiredCapability
                    + ": " + classified.summary();
        return new Evaluation(
                risk,
                effectiveEffect,
                effectiveEffect == PolicyEffect.ALLOW,
                summary,
                classified.action(),
                classified.environment(),
                effectDigest,
                requiredCapability,
                configured
        );
    }

    private HumanApprovalRisk risk(String action, HumanApprovalType type, PolicyEffect effect) {
        if (effect == PolicyEffect.DENY) return HumanApprovalRisk.HIGH;
        if ("PRODUCTION_DEPLOY".equals(action)
                || "PRODUCTION_DML".equals(action)
                || "DELETE_DATA".equals(action)) {
            return HumanApprovalRisk.HIGH;
        }
        if (type == HumanApprovalType.USER_INPUT || effect == PolicyEffect.REQUIRE_HUMAN) {
            return HumanApprovalRisk.ELEVATED;
        }
        return HumanApprovalRisk.LOW;
    }

    public record Evaluation(
            HumanApprovalRisk risk,
            PolicyEffect effect,
            boolean autoApprove,
            String summary,
            String action,
            String environment,
            String effectDigest,
            AgentCapabilityProfile.Capability requiredCapability,
            PolicyDecision configuredDecision
    ) {}
}
