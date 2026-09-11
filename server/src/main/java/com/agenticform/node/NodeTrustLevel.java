package com.agenticform.node;

public enum NodeTrustLevel {
    UNTRUSTED,
    STANDARD,
    TRUSTED,
    PRIVILEGED;

    public boolean atLeast(NodeTrustLevel required) {
        return ordinal() >= required.ordinal();
    }
}
