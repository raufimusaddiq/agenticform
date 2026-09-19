package com.agenticform.event;

import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

class ControlPlaneEventBusRunOutputTest {
    @Test
    void publishRunOutputDoesNotFailWithoutSubscribers() {
        ControlPlaneEventBus bus = new ControlPlaneEventBus();
        SseEmitter emitter = bus.subscribe();
        assertDoesNotThrow(() -> bus.publishRunOutput(UUID.randomUUID(), "hello"));
        emitter.complete();
    }
}
