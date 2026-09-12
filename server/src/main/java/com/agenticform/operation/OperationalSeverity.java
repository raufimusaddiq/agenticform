package com.agenticform.operation;

public enum OperationalSeverity {
    INFO,
    WARNING,
    HIGH,
    CRITICAL;

    public boolean higherThan(OperationalSeverity other) {
        return other == null || ordinal() > other.ordinal();
    }
}
