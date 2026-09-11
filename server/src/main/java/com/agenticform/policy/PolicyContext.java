package com.agenticform.policy;

import java.util.UUID;

public record PolicyContext(
        UUID projectId,
        UUID agentId,
        UUID taskId,
        String action,
        String environment
) {}
