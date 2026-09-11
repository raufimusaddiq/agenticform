package com.agenticform.operation;

import com.agenticform.config.AgenticformProperties;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

@Service
public class GitHubActionsGateway {
    public record WorkflowResult(long runId, String status, String conclusion, String htmlUrl,
                                 String headSha, String headBranch, String displayTitle) {}

    private record WorkflowRun(long id, String status, String conclusion, String htmlUrl,
                               String headSha, String headBranch, String displayTitle,
                               String event, Instant createdAt) {}

    private static final Pattern REPOSITORY = Pattern.compile("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+");
    private static final Pattern WORKFLOW = Pattern.compile("[A-Za-z0-9_.-]+(?:\\.ya?ml)?");
    private static final Pattern REF = Pattern.compile("[A-Za-z0-9._/-]{1,255}");

    private final AgenticformProperties.GitHub properties;
    private final ObjectMapper mapper;
    private final HttpClient client;

    public GitHubActionsGateway(AgenticformProperties properties, ObjectMapper mapper) {
        this.properties = properties.getGithub();
        this.mapper = mapper;
        this.client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    public boolean configured() {
        return properties.getToken() != null && !properties.getToken().isBlank();
    }

    public WorkflowResult waitForWorkflow(String repository, String workflow, String ref,
                                          String headSha, int timeoutSeconds) throws Exception {
        requireConfigured();
        validate(repository, workflow, ref);
        if (headSha == null || headSha.isBlank()) {
            throw new IllegalArgumentException("GitHub WAIT mode requires headSha");
        }
        return waitForRun(repository, workflow, ref, headSha.trim(), null,
                Instant.now().plusSeconds(timeoutSeconds));
    }

    public WorkflowResult dispatchAndWait(String repository, String workflow, String ref,
                                          Map<String, String> inputs, String expectedHeadSha,
                                          int timeoutSeconds) throws Exception {
        requireConfigured();
        validate(repository, workflow, ref);
        Instant notBefore = Instant.now().minusSeconds(2);

        ObjectNode payload = mapper.createObjectNode();
        payload.put("ref", ref);
        ObjectNode inputNode = payload.putObject("inputs");
        if (inputs != null) {
            inputs.forEach((key, value) -> inputNode.put(key, value));
        }

        HttpRequest request = baseRequest(workflowUri(repository, workflow, "/dispatches"))
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload)))
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 204) {
            throw new IllegalStateException("GitHub workflow dispatch returned HTTP " + response.statusCode());
        }

        return waitForRun(repository, workflow, ref,
                expectedHeadSha == null || expectedHeadSha.isBlank() ? null : expectedHeadSha.trim(),
                notBefore, Instant.now().plusSeconds(timeoutSeconds));
    }

    private WorkflowResult waitForRun(String repository, String workflow, String ref, String expectedHeadSha,
                                      Instant notBefore, Instant deadline) throws Exception {
        WorkflowRun selected = null;
        while (Instant.now().isBefore(deadline)) {
            var candidates = listRuns(repository, workflow).stream()
                    .filter(run -> expectedHeadSha == null || expectedHeadSha.equals(run.headSha()))
                    .filter(run -> ref == null || ref.isBlank() || ref.equals(run.headBranch()))
                    .filter(run -> notBefore == null || !run.createdAt().isBefore(notBefore))
                    .sorted(Comparator.comparing(WorkflowRun::createdAt).reversed())
                    .toList();

            if (notBefore != null && candidates.size() > 1) {
                throw new IllegalStateException("Ambiguous GitHub workflow dispatch: multiple matching runs appeared; retry after concurrent dispatches finish");
            }
            if (!candidates.isEmpty()) selected = candidates.get(0);

            if (selected != null && "completed".equalsIgnoreCase(selected.status())) {
                if (!"success".equalsIgnoreCase(selected.conclusion())) {
                    throw new IllegalStateException("GitHub workflow run " + selected.id()
                            + " completed with conclusion " + selected.conclusion());
                }
                return result(selected);
            }

            Thread.sleep(Math.max(250L, properties.getPollInterval().toMillis()));
        }

        if (selected == null) {
            throw new IllegalStateException("Timed out waiting for GitHub workflow run to appear");
        }
        throw new IllegalStateException("Timed out waiting for GitHub workflow run " + selected.id() + " to complete");
    }

    private java.util.List<WorkflowRun> listRuns(String repository, String workflow) throws Exception {
        URI uri = workflowUri(repository, workflow, "/runs?per_page=30");
        HttpRequest request = baseRequest(uri).GET().build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IllegalStateException("GitHub workflow runs request returned HTTP " + response.statusCode());
        }

        JsonNode root = mapper.readTree(response.body());
        java.util.ArrayList<WorkflowRun> runs = new java.util.ArrayList<>();
        for (JsonNode node : root.path("workflow_runs")) {
            Instant createdAt;
            try {
                createdAt = Instant.parse(node.path("created_at").asText());
            } catch (Exception error) {
                continue;
            }
            runs.add(new WorkflowRun(
                    node.path("id").asLong(),
                    node.path("status").asText(),
                    nullableText(node, "conclusion"),
                    nullableText(node, "html_url"),
                    nullableText(node, "head_sha"),
                    nullableText(node, "head_branch"),
                    nullableText(node, "display_title"),
                    nullableText(node, "event"),
                    createdAt
            ));
        }
        return java.util.List.copyOf(runs);
    }

    private HttpRequest.Builder baseRequest(URI uri) {
        return HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(30))
                .header("Accept", "application/vnd.github+json")
                .header("Authorization", "Bearer " + properties.getToken())
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("Content-Type", "application/json");
    }

    private URI workflowUri(String repository, String workflow, String suffix) {
        String base = properties.getApiUrl().toString();
        if (!base.endsWith("/")) base += "/";
        String path = "repos/" + repository + "/actions/workflows/"
                + URLEncoder.encode(workflow, StandardCharsets.UTF_8) + suffix;
        return URI.create(base + path);
    }

    private WorkflowResult result(WorkflowRun run) {
        return new WorkflowResult(run.id(), run.status(), run.conclusion(), run.htmlUrl(),
                run.headSha(), run.headBranch(), run.displayTitle());
    }

    private void requireConfigured() {
        if (!configured()) {
            throw new IllegalStateException("GitHub Actions integration is not configured; set AGENTICFORM_GITHUB_TOKEN");
        }
    }

    private void validate(String repository, String workflow, String ref) {
        if (repository == null || !REPOSITORY.matcher(repository.trim()).matches()) {
            throw new IllegalArgumentException("Invalid GitHub repository; expected owner/name");
        }
        if (workflow == null || !WORKFLOW.matcher(workflow.trim()).matches()) {
            throw new IllegalArgumentException("Invalid GitHub workflow file/id");
        }
        if (ref == null || !REF.matcher(ref.trim()).matches() || ref.contains("..")) {
            throw new IllegalArgumentException("Invalid GitHub workflow ref");
        }
    }

    private String nullableText(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
