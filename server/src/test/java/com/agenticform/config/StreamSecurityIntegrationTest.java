package com.agenticform.config;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import org.apache.catalina.startup.Tomcat;
import org.apache.tomcat.util.descriptor.web.FilterDef;
import org.apache.tomcat.util.descriptor.web.FilterMap;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.filter.DelegatingFilterProxy;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Executors;

import static org.junit.jupiter.api.Assertions.*;

class StreamSecurityIntegrationTest {
    private static final String TOKEN = "stream-test-admin-token-at-least-32-characters";
    @TempDir static Path directory;
    private static Tomcat tomcat;
    private static AnnotationConfigWebApplicationContext spring;
    private static String base;
    private static final List<Throwable> failures = new CopyOnWriteArrayList<>();
    private static volatile CountDownLatch redispatched;
    private static volatile SseEmitter currentEmitter;

    @BeforeAll
    static void start() throws Exception {
        tomcat = new Tomcat();
        tomcat.setBaseDir(directory.toString());
        tomcat.setPort(System.getenv("STREAM_TEST_PROXY_URL") == null ? 0 : 8080);
        tomcat.getConnector();
        var context = tomcat.addContext("", directory.toString());
        spring = new AnnotationConfigWebApplicationContext();
        spring.setServletContext(context.getServletContext());
        spring.register(TestConfiguration.class);
        spring.refresh();
        context.getServletContext().setAttribute(WebApplicationContext.ROOT_WEB_APPLICATION_CONTEXT_ATTRIBUTE, spring);
        var servlet = Tomcat.addServlet(context, "dispatcher", new DispatcherServlet(spring));
        servlet.setAsyncSupported(true);
        servlet.setLoadOnStartup(1);
        context.addServletMappingDecoded("/", "dispatcher");
        var security = new DelegatingFilterProxy("springSecurityFilterChain", spring);
        addFilter(context, "security", (request, response, chain) -> {
            try { security.doFilter(request, response, chain); }
            catch (RuntimeException | jakarta.servlet.ServletException error) {
                failures.add(error);
                throw error;
            } finally {
                if (request.getDispatcherType() == DispatcherType.ASYNC) redispatched.countDown();
            }
        });
        addFilter(context, "observe", (request, response, chain) -> {
            if (request.getDispatcherType() == DispatcherType.ASYNC) {
                var authentication = SecurityContextHolder.getContext().getAuthentication();
                if (authentication == null || !"agenticform-admin".equals(authentication.getName())) {
                    failures.add(new IllegalStateException("Async dispatch lost admin identity"));
                }
            }
            chain.doFilter(request, response);
        });
        tomcat.start();
        base = System.getenv().getOrDefault("STREAM_TEST_PROXY_URL", "http://127.0.0.1:" + tomcat.getConnector().getLocalPort());
    }

    private static void addFilter(org.apache.catalina.Context context, String name, Filter filter) {
        FilterDef definition = new FilterDef();
        definition.setFilterName(name);
        definition.setFilter(filter);
        definition.setAsyncSupported("true");
        context.addFilterDef(definition);
        FilterMap mapping = new FilterMap();
        mapping.setFilterName(name);
        mapping.addURLPattern("/*");
        for (String dispatcher : List.of("REQUEST", "ASYNC", "ERROR")) mapping.setDispatcher(dispatcher);
        context.addFilterMap(mapping);
    }

    @AfterAll
    static void stop() throws Exception {
        if (tomcat != null) { tomcat.stop(); tomcat.destroy(); }
        if (spring != null) spring.close();
    }

    @Test
    void bothStreamsRejectMissingAndInvalidTokens() throws Exception {
        try (HttpClient client = HttpClient.newHttpClient()) {
            for (String path : List.of("/api/events/stream", "/api/agents/stream")) {
                for (String token : List.of("", "wrong-token")) {
                    var request = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(5));
                    if (!token.isEmpty()) request.header("Authorization", "Bearer " + token);
                    assertEquals(401, client.send(request.build(), HttpResponse.BodyHandlers.discarding()).statusCode());
                }
            }
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "STREAM_TEST_PROXY_URL", matches = ".+")
    void bothStreamsSurviveTheFormerProxyIdleTimeout() throws Exception {
        failures.clear();
        redispatched = new CountDownLatch(2);
        try (HttpClient client = HttpClient.newHttpClient(); var timer = Executors.newSingleThreadScheduledExecutor()) {
            var responses = new java.util.ArrayList<HttpResponse<java.io.InputStream>>();
            var emitters = new java.util.ArrayList<SseEmitter>();
            for (String path : List.of("/api/events/stream", "/api/agents/stream")) {
                var request = HttpRequest.newBuilder(URI.create(base + path + "?mode=idle"))
                        .timeout(Duration.ofSeconds(80)).header("Authorization", "Bearer " + TOKEN).build();
                responses.add(client.send(request, HttpResponse.BodyHandlers.ofInputStream()));
                emitters.add(currentEmitter);
            }
            var send = timer.schedule(() -> {
                for (var emitter : emitters) {
                    try { emitter.send(SseEmitter.event().data("after-idle")); }
                    catch (Exception error) { failures.add(error); }
                    finally { emitter.complete(); }
                }
            }, 65, TimeUnit.SECONDS);
            try {
                for (var response : responses) {
                    assertEquals(200, response.statusCode());
                    String body = new String(response.body().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                    assertTrue(body.contains("data:after-idle"), body);
                }
                send.get(5, TimeUnit.SECONDS);
                assertTrue(redispatched.await(5, TimeUnit.SECONDS));
                assertTrue(failures.isEmpty(), failures.toString());
            } finally {
                for (var response : responses) response.body().close();
            }
        }
    }

    @Test
    void bothStreamsKeepAuthenticationAcrossCompletionTimeoutAndError() throws Exception {
        for (String path : List.of("/api/events/stream", "/api/agents/stream")) {
            for (String mode : List.of("complete", "timeout", "error", "disconnect")) {
                failures.clear();
                redispatched = new CountDownLatch(1);
                try (HttpClient client = HttpClient.newHttpClient()) {
                    var request = HttpRequest.newBuilder(URI.create(base + path + "?mode=" + mode))
                            .timeout(Duration.ofSeconds(8)).header("Authorization", "Bearer " + TOKEN).build();
                    var response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
                    assertEquals(200, response.statusCode());
                    try (var reader = new BufferedReader(new InputStreamReader(response.body()))) {
                        assertEquals("data:ready", reader.readLine());
                        if (mode.equals("disconnect")) response.body().close();
                        if (mode.equals("error")) currentEmitter.completeWithError(new IllegalStateException("test stream error"));
                        else if (!mode.equals("timeout")) currentEmitter.complete();
                        assertTrue(redispatched.await(5, TimeUnit.SECONDS), path + " " + mode + " did not pass authenticated async dispatch: " + failures);
                    }
                }
                assertTrue(failures.isEmpty(), path + " " + mode + ": " + failures);
            }
        }
    }

    @Configuration
    @EnableWebMvc
    @EnableWebSecurity
    @Import(SecurityConfig.class)
    static class TestConfiguration {
        @Bean AgenticformProperties properties() {
            var properties = new AgenticformProperties();
            properties.getSecurity().setAdminToken(TOKEN);
            return properties;
        }
        @Bean AdminBearerAuthenticationFilter adminFilter(AgenticformProperties properties) {
            return new AdminBearerAuthenticationFilter(properties);
        }
        @Bean StreamController streams() { return new StreamController(); }
    }

    @RestController
    static class StreamController {
        @org.springframework.web.bind.annotation.ExceptionHandler(IllegalStateException.class)
        void handleExpectedStreamError(IllegalStateException error) {
            assertEquals("test stream error", error.getMessage());
        }

        @GetMapping(value = {"/api/events/stream", "/api/agents/stream"}, produces = "text/event-stream")
        SseEmitter stream(@org.springframework.web.bind.annotation.RequestParam String mode) throws Exception {
            var emitter = new SseEmitter(mode.equals("timeout") ? 200L : 0L);
            currentEmitter = emitter;
            emitter.send(SseEmitter.event().data("ready"));
            return emitter;
        }
    }
}
