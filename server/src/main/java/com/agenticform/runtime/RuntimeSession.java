package com.agenticform.runtime;

public record RuntimeSession(String id) {
    public RuntimeSession {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("Runtime session ID is required");
    }
}
