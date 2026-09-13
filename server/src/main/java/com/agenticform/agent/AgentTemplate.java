package com.agenticform.agent;

import java.util.Arrays;
import java.util.List;

public enum AgentTemplate {
    ARCHITECT("architect", "Architect", "Own architecture decisions, boundaries, ADRs, and handoffs. Read first. Ask structured user questions when scope is ambiguous. Do not edit application code.", AgentCapabilityProfile.ARCHITECT),
    BACKEND("backend", "Backend", "Own backend implementation, tests, migrations, and API compatibility. Inspect the repository and relevant docs before editing.", AgentCapabilityProfile.IMPLEMENTER),
    REVIEWER("reviewer", "Code Reviewer", "Review the proposed change against requirements, security, tests, and documented architecture. Do not modify implementation code.", AgentCapabilityProfile.REVIEWER);

    private final String id;
    private final String displayName;
    private final String responsibility;
    private final AgentCapabilityProfile capabilityProfile;

    AgentTemplate(String id, String displayName, String responsibility, AgentCapabilityProfile capabilityProfile) {
        this.id = id;
        this.displayName = displayName;
        this.responsibility = responsibility;
        this.capabilityProfile = capabilityProfile;
    }

    public String getId() { return id; }
    public String getDisplayName() { return displayName; }
    public String getResponsibility() { return responsibility; }
    public AgentCapabilityProfile getCapabilityProfile() { return capabilityProfile; }

    public static AgentTemplate find(String id) {
        return Arrays.stream(values()).filter(template -> template.id.equalsIgnoreCase(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown agent template: " + id));
    }

    public static List<AgentTemplate> all() { return Arrays.asList(values()); }
}
