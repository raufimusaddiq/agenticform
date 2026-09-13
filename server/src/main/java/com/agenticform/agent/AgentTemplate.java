package com.agenticform.agent;

import java.util.Arrays;
import java.util.List;

public enum AgentTemplate {
    ARCHITECT("architect", "Architect", "Own architecture decisions, boundaries, ADRs, and handoffs. Read first. Ask structured user questions when scope is ambiguous. Do not edit application code.", AgentCapabilityProfile.ARCHITECT, "ARCHITECTURE"),
    ORCHESTRATOR("orchestrator", "Orchestrator", "Own the user-facing workflow. Decompose the request, delegate architecture, matching implementers, tests, and review; track dependencies; collect reports; send one concise project result. Do not edit application code.", AgentCapabilityProfile.ORCHESTRATOR, "ORCHESTRATION"),
    IMPLEMENTER("implementer", "Implementer", "Implement assigned product work, tests, and documentation within the agreed scope. Choose the correct source area from the task; report changed files and validation.", AgentCapabilityProfile.IMPLEMENTER, "GENERAL"),
    FRONTEND("frontend", "Frontend Implementer", "Own frontend implementation, accessibility, UI behavior, and frontend tests. Inspect the repository and relevant docs before editing.", AgentCapabilityProfile.IMPLEMENTER, "FRONTEND"),
    DATA("data", "Data Implementer", "Own data modeling, pipelines, migrations, quality checks, and data tests. Inspect the repository and relevant docs before editing.", AgentCapabilityProfile.IMPLEMENTER, "DATA"),
    DEVOPS("devops", "DevOps Implementer", "Own source-controlled build, CI, infrastructure, and deployment configuration changes. Use the Operational Agent for production effects.", AgentCapabilityProfile.IMPLEMENTER, "DEVOPS"),
    REVIEWER("reviewer", "Reviewer", "Review the proposed change against requirements, security, tests, and documented architecture. Do not modify implementation code.", AgentCapabilityProfile.REVIEWER, "REVIEW");

    private final String id;
    private final String displayName;
    private final String responsibility;
    private final AgentCapabilityProfile capabilityProfile;
    private final String specialty;

    AgentTemplate(String id, String displayName, String responsibility, AgentCapabilityProfile capabilityProfile, String specialty) {
        this.id = id;
        this.displayName = displayName;
        this.responsibility = responsibility;
        this.capabilityProfile = capabilityProfile;
        this.specialty = specialty;
    }

    public String getId() { return id; }
    public String getDisplayName() { return displayName; }
    public String getResponsibility() { return responsibility; }
    public AgentCapabilityProfile getCapabilityProfile() { return capabilityProfile; }
    public String getSpecialty() { return specialty; }

    public static AgentTemplate find(String id) {
        return Arrays.stream(values()).filter(template -> template.id.equalsIgnoreCase(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown agent template: " + id));
    }

    public static List<AgentTemplate> all() { return Arrays.asList(values()); }
}
