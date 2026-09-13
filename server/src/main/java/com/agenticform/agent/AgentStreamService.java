package com.agenticform.agent;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArraySet;

@Service
public class AgentStreamService {
    private final AgentRepository agents;
    private final CopyOnWriteArraySet<SseEmitter> subscribers = new CopyOnWriteArraySet<>();

    public AgentStreamService(AgentRepository agents) {
        this.agents = agents;
    }

    public SseEmitter subscribe() {
        SseEmitter emitter = new SseEmitter(0L);
        subscribers.add(emitter);
        emitter.onCompletion(() -> subscribers.remove(emitter));
        emitter.onTimeout(() -> subscribers.remove(emitter));
        emitter.onError(error -> subscribers.remove(emitter));
        send(emitter);
        return emitter;
    }

    @Scheduled(fixedDelayString = "${agenticform.agent-stream.delay-ms:2000}")
    public void publishSnapshot() {
        if (subscribers.isEmpty()) return;
        for (SseEmitter emitter : subscribers) send(emitter);
    }

    private void send(SseEmitter emitter) {
        try {
            emitter.send(SseEmitter.event().name("agents").data(List.copyOf(agents.findAll())));
        } catch (IOException | IllegalStateException error) {
            subscribers.remove(emitter);
            try { emitter.complete(); } catch (Exception ignored) {}
        }
    }
}
