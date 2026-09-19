package com.agenticform.task;

/**
 * The requested outcome contract for a task. Persisted at creation so completion
 * checks never depend on prompt wording.
 */
public enum TaskDeliverable {
    GENERAL,
    ANALYSIS,
    DOCUMENTATION,
    IMPLEMENTATION,
    REVIEW,
    TEST,
    OPERATIONS
}
