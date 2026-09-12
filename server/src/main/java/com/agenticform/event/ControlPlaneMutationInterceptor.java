package com.agenticform.event;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.Set;

@Component
public class ControlPlaneMutationInterceptor implements HandlerInterceptor {
    private static final Set<String> MUTATING_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");
    private final ControlPlaneEventBus events;

    public ControlPlaneMutationInterceptor(ControlPlaneEventBus events) {
        this.events = events;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception exception) {
        if (exception != null || response.getStatus() >= 400) return;
        if (!request.getRequestURI().startsWith("/api/")) return;
        if (request.getRequestURI().startsWith("/api/events/")) return;
        if (!MUTATING_METHODS.contains(request.getMethod())) return;
        events.publish("api.mutation");
    }
}
