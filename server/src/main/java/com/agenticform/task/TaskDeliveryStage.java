package com.agenticform.task;

/**
 * Delivery milestones for a task. Only {@link #DELIVERED} satisfies a task whose
 * requested deliverable must reach a verified target environment.
 */
public enum TaskDeliveryStage {
    NOT_STARTED,
    IMPLEMENTED,
    REVIEW_PASSED,
    MERGED,
    ARTIFACT_PUBLISHED,
    DEPLOYING,
    DEPLOYMENT_VERIFIED,
    DELIVERED
}
