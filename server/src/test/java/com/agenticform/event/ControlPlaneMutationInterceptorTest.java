package com.agenticform.event;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ControlPlaneMutationInterceptorTest {
    private final ControlPlaneEventBus events = mock(ControlPlaneEventBus.class);
    private final ControlPlaneMutationInterceptor interceptor = new ControlPlaneMutationInterceptor(events);

    @Test
    void publishesAfterSuccessfulApiMutation() {
        HttpServletRequest request = request("POST", "/api/tasks");
        HttpServletResponse response = response(201);

        interceptor.afterCompletion(request, response, new Object(), null);

        verify(events).publish("api.mutation");
    }

    @Test
    void ignoresFailedMutation() {
        HttpServletRequest request = request("DELETE", "/api/policies/rules/1");
        HttpServletResponse response = response(409);

        interceptor.afterCompletion(request, response, new Object(), null);

        verify(events, never()).publish("api.mutation");
    }

    @Test
    void ignoresReadsAndEventStreamItself() {
        HttpServletResponse response = response(200);
        interceptor.afterCompletion(request("GET", "/api/tasks"), response, new Object(), null);
        interceptor.afterCompletion(request("POST", "/api/events/stream"), response, new Object(), null);

        verify(events, never()).publish("api.mutation");
    }

    private HttpServletRequest request(String method, String uri) {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getMethod()).thenReturn(method);
        when(request.getRequestURI()).thenReturn(uri);
        return request;
    }

    private HttpServletResponse response(int status) {
        HttpServletResponse response = mock(HttpServletResponse.class);
        when(response.getStatus()).thenReturn(status);
        return response;
    }
}
