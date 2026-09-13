package com.agenticform.node;

import tools.jackson.databind.JsonNode;

import java.util.UUID;

public interface RemoteInteractionService {
    void ready(UUID interactionId, JsonNode response);
}
