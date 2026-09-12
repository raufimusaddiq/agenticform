package com.agenticform.agent;

import java.util.EnumSet;
import java.util.Set;

public enum AgentCapabilityProfile {
    IMPLEMENTER(EnumSet.of(Capability.READ, Capability.WRITE, Capability.TEST, Capability.COMMIT, Capability.MESSAGE)),
    REVIEWER(EnumSet.of(Capability.READ, Capability.TEST, Capability.REVIEW, Capability.MESSAGE)),
    ARCHITECT(EnumSet.of(Capability.READ, Capability.MESSAGE)),
    OPS(EnumSet.of(Capability.READ, Capability.TEST, Capability.MESSAGE, Capability.DEPLOY));

    public enum Capability {
        READ,
        WRITE,
        TEST,
        COMMIT,
        MESSAGE,
        REVIEW,
        MERGE,
        DEPLOY
    }

    private final Set<Capability> capabilities;

    AgentCapabilityProfile(Set<Capability> capabilities) {
        this.capabilities = Set.copyOf(capabilities);
    }

    public boolean allows(Capability capability) {
        return capabilities.contains(capability);
    }

    public Set<Capability> capabilities() {
        return capabilities;
    }
}
