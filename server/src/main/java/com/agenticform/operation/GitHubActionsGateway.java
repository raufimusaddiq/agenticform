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
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

@Service
public class GitHubActionsGateway {
    public record WorkflowRun(long runId, String status, String conclusion, String htmlUrl,
                              String headSha, String headBranch, String displayTitle,
                              String event, String workflowPath, Instant createdAt) {}

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

    public Instant dispatchWorkflow(String repository, String workflow, String ref,
                                    Map<String, String> inputs) throws Exception {
        requireConfigured();
        validate(repository, workflow, ref);
        Instant correlationNotBefore = Instant.now().minusSeconds(2);

        ObjectNode payload = mapper.createObjectNode();
        payload.put("ref", ref);
        ObjectNode inputNode = payload.putObject("inputs");
        if (inputs != null) inputs.forEach(inputNode::put);

        HttpRequest request = baseRequest(workflowUri(repository, workflow, "/dispatches"))
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload)))
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 204) {
            throw new IllegalStateException("GitHub workflow dispatch returned HTTP " + response.statusCode());
        }
        return correlationNotBefore;
    }

    public List<WorkflowRun> listWorkflowRuns(String repository, String workflow) throws Exception {
        requireConfigured();
        validate(repository, workflow, "main");
        URI uri = workflowUri(repository, workflow, "/runs?per_page=30");
        HttpRequest request = baseRequest(uri).GET().build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IllegalStateException("GitHub workflow runs request returned HTTP " + response.statusCode());
        }

        JsonNode root = mapper.readTree(response.body());
        ArrayList<WorkflowRun> runs = new ArrayList<>();
        for (JsonNode node : root.path("workflow_runs")) {
            WorkflowRun run = parseRun(node);
            if (run != null) runs.add(run);
        }
        return List.copyOf(runs);
    }

    public WorkflowRun getWorkflowRun(String repository, long runId) throws Exception {
        requireConfigured();
        if (repository == null || !REPOSITORY.matcher(repository.trim()).matches()) {
            throw new IllegalArgumentException("Invalid GitHub repository; expected owner/name");
        }
        String base = properties.getApiUrl().toString();
        if (!base.endsWith("/")) base += "/";
        URI uri = URI.create(base + "repos/" + repository + "/actions/runs/" + runId);
        HttpResponse<String> response = client.send(baseRequest(uri).GET().build(), HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IllegalStateException("GitHub workflow run request returned HTTP " + response.statusCode());
        }
        WorkflowRun run = parseRun(mapper.readTree(response.body()));
        if (run == null) throw new IllegalStateException("GitHub workflow run response was missing created_at");
        return run;
    }

    private WorkflowRun parseRun(JsonNode node) {
        Instant createdAt;
        try {
            createdAt = Instant.parse(node.path("created_at").asText());
        } catch (Exception error) {
            return null;
        }
        return new WorkflowRun(
                node.path("id").asLong(),
                node.path("status").asText(),
                nullableText(node, "conclusion"),
                nullableText(node, "html_url"),
                nullableText(node, "head_sha"),
                nullableText(node, "head_branch"),
                nullableText(node, "display_title"),
                nullableText(node, "event"),
                nullableText(node, "path"),
                createdAt
        );
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
