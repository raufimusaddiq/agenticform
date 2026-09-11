package com.agenticform.task;

public enum TaskStatus {
    QUEUED,
    READY,
    DISPATCHING,
    DISPATCHED,
    RUNNING,
    BLOCKED,
    WAITING_APPROVAL,
    PAUSED,
    COMPLETED,
    FAILED,
    CANCELLED
}
