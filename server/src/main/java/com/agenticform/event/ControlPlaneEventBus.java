package com.agenticform.event;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.atomic.AtomicLong;

@Component
public class ControlPlaneEventBus {
    private final AtomicLong sequence = new AtomicLong();
    private final CopyOnWriteArraySet<SseEmitter> subscribers = new CopyOnWriteArraySet<>();

    public SseEmitter subscribe() {
        SseEmitter emitter = new SseEmitter(0L);
        subscribers.add(emitter);
        emitter.onCompletion(() -> subscribers.remove(emitter));
        emitter.onTimeout(() -> subscribers.remove(emitter));
        emitter.onError(error -> subscribers.remove(emitter));
        send(emitter, event("ready", null, null));
        return emitter;
    }

    public void publish(String type) {
        publish(type, null, null);
    }

    public void publish(String type, UUID projectId, UUID entityId) {
        Event event = event(type, projectId, entityId);
        for (SseEmitter emitter : subscribers) send(emitter, event);
    }

    @Scheduled(fixedDelayString = "${agenticform.events.reconcile-delay-ms:30000}")
    public void reconciliationPulse() {
        publish("reconcile");
    }

    private Event event(String type, UUID projectId, UUID entityId) {
        return new Event(sequence.incrementAndGet(), type, projectId, entityId, Instant.now());
    }

    private void send(SseEmitter emitter, Event event) {
        try {
            emitter.send(SseEmitter.event()
                    .id(Long.toString(event.sequence()))
                    .name("control-plane")
                    .data(event));
        } catch (IOException | IllegalStateException error) {
            subscribers.remove(emitter);
            try { emitter.complete(); } catch (Exception ignored) {}
        }
    }

    int subscriberCount() { return subscribers.size(); }

    public record Event(long sequence, String type, UUID projectId, UUID entityId, Instant occurredAt) {}
}
