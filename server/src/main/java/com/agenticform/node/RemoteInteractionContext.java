package com.agenticform.node;

import org.springframework.stereotype.Component;

import java.util.UUID;
import java.util.function.Supplier;

@Component
public class RemoteInteractionContext {
    private final ThreadLocal<UUID> current = new ThreadLocal<>();

    public UUID currentInteractionId() { return current.get(); }

    public <T> T within(UUID interactionId, Supplier<T> work) {
        UUID previous = current.get();
        current.set(interactionId);
        try {
            return work.get();
        } finally {
            if (previous == null) current.remove();
            else current.set(previous);
        }
    }
}
