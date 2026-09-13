package com.agenticform.runtime;

import tools.jackson.databind.JsonNode;

public record RuntimeApprovalRequest(String requestId, RuntimeType runtimeType, String runtimeSessionId,
                                     String method, JsonNode params) {}
