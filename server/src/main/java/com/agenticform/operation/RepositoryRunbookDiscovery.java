package com.agenticform.operation;

import com.agenticform.config.AgenticformProperties;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectRepository;
import com.agenticform.project.ProjectService;
import com.agenticform.project.ProjectSourceType;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.NoSuchElementException;
import java.util.UUID;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * Discovers a project-owned deployment runbook from the repository itself.
 *
 * <p>Agenticform stays project-agnostic: when the repository carries
 * {@code .agenticform/runbook.json} for a supported environment, that runbook is
 * validated with the same rules as a hand-registered runbook and registered in the
 * operational registry. When the repository does not carry one (or the manifest is
 * unusable), discovery reports the standard human-gated deployment fallback instead
 * of inventing commands. Nothing is ever executed by discovery itself: registration
 * only makes the runbook available for policy-evaluated {@code request_operation}.
 */
@Service
public class RepositoryRunbookDiscovery {
    public static final String MANIFEST_PATH = ".agenticform/runbook.json";
    public static final String FALLBACK_KEY = "production-deploy-human";
    private static final Pattern SECRET_INPUT = Pattern.compile("(?i).*(token|secret|password|credential|private[_-]?key|api[_-]?key).*");

    /** Where the manifest came from. */
    public enum Source { REPOSITORY_MANIFEST, HUMAN_GATED_FALLBACK }

    public record Plan(
            UUID projectId,
            Source source,
            String manifestPath,
            String repository,
            String commitSha,
            OperationalEnvironmentEntity environment,
            String runbookKey,
            String action,
            String description,
            List<OperationalRegistryService.StepSpec> steps,
            boolean registered,
            String fallbackReason,
            String approvalExpectation
    ) {}

    private final ProjectRepository projectRepository;
    private final ProjectService projectService;
    private final OperationalRegistryService registry;
    private final GitHubManifestClient client;
    private final ObjectMapper mapper;

    @Autowired
    public RepositoryRunbookDiscovery(ProjectRepository projectRepository,
                                      ProjectService projectService,
                                      OperationalRegistryService registry,
                                      AgenticformProperties properties,
                                      ObjectMapper mapper) {
        this(projectRepository, projectService, registry,
                new GitHubManifestClient(properties.getGithub()), mapper);
    }

    /**
     * Test seam: injects the GitHub reader directly. Kept package-private and
     * non-autowired so Spring always uses the production constructor above.
     */
    RepositoryRunbookDiscovery(ProjectRepository projectRepository,
                               ProjectService projectService,
                               OperationalRegistryService registry,
                               GitHubManifestClient client,
                               ObjectMapper mapper) {
        this.projectRepository = projectRepository;
        this.projectService = projectService;
        this.registry = registry;
        this.client = client;
        this.mapper = mapper;
    }

    /** Discovers the runbook and registers it when it is usable. */
    public Plan sync(UUID projectId, String environmentKey) {
        Plan plan = plan(projectId, environmentKey);
        if (plan.source() != Source.REPOSITORY_MANIFEST) return plan;
        OperationalRunbookEntity registered = upsert(plan);
        return new Plan(plan.projectId(), plan.source(), plan.manifestPath(), plan.repository(), plan.commitSha(),
                plan.environment(), registered.getKey(), registered.getAction(), registered.getDescription(),
                registry.decodeSteps(registered.getDefinitionJson()), true, null, plan.approvalExpectation());
    }

    /** Creates a pull request containing a validated Operational-Agent-authored manifest. */
    public ObjectNode propose(UUID projectId, String environmentKey, JsonNode manifest) {
        ProjectEntity project = projectRepository.findById(projectId)
                .orElseThrow(() -> new NoSuchElementException("Project not found: " + projectId));
        OperationalEnvironmentEntity environment = resolveEnvironment(projectId, environmentKey);
        if (project.getSourceType() != ProjectSourceType.GIT || blank(project.getRepositoryUrl()))
            throw new IllegalArgumentException("Project has no Git repository");
        String repository = GitHubManifestClient.repositoryPath(project.getRepositoryUrl());
        if (repository == null) throw new IllegalArgumentException("Repository must be a github.com owner/repository URL");
        String token = projectService.githubToken(projectId);
        String headSha = client.resolveCommitSha(repository, project.getDefaultBranch(), token);
        if (client.fetchManifest(repository, headSha, token) != null)
            throw new IllegalArgumentException("Repository already has " + MANIFEST_PATH + "; review/update that runbook instead");
        ParsedRunbook parsed = parse(manifest, environment.getKey());
        registry.validateSteps(projectId, environment.getId(), parsed.steps());
        String branch = "agenticform/runbook-" + UUID.randomUUID();
        String content;
        try { content = mapper.writeValueAsString(manifest); }
        catch (Exception error) { throw new IllegalStateException("Unable to serialize runbook manifest", error); }
        client.createBranch(repository, branch, headSha, token);
        client.createFile(repository, branch, content, token);
        ObjectNode pr = client.createPullRequest(repository, branch, project.getDefaultBranch(),
                "Add Agenticform deployment runbook", "Generated from repository evidence by the Operational Agent. Review every step before merging. Merge is required before discovery; deployment remains REQUIRE_HUMAN.", token);
        ObjectNode result = mapper.createObjectNode();
        result.put("repository", repository); result.put("branch", branch); result.put("baseCommit", headSha);
        result.put("manifestPath", MANIFEST_PATH); result.put("pullRequest", pr.path("html_url").asText());
        result.put("approval", "Human review and merge required; deployment remains REQUIRE_HUMAN.");
        return result;
    }

    /** Bounded source files at the pinned default-branch commit for evidence-based authoring. */
    public ObjectNode evidence(UUID projectId) {
        ProjectEntity project = projectRepository.findById(projectId)
                .orElseThrow(() -> new NoSuchElementException("Project not found: " + projectId));
        if (project.getSourceType() != ProjectSourceType.GIT || blank(project.getRepositoryUrl()))
            throw new IllegalArgumentException("Project has no Git repository");
        String repository = GitHubManifestClient.repositoryPath(project.getRepositoryUrl());
        if (repository == null) throw new IllegalArgumentException("Repository must be a github.com owner/repository URL");
        String token = projectService.githubToken(projectId);
        String sha = client.resolveCommitSha(repository, project.getDefaultBranch(), token);
        return client.fetchEvidence(repository, sha, token);
    }

    /** Resolves what would be used without registering anything. */
    public Plan plan(UUID projectId, String environmentKey) {
        ProjectEntity project = projectRepository.findById(projectId)
                .orElseThrow(() -> new NoSuchElementException("Project not found: " + projectId));
        OperationalEnvironmentEntity environment = resolveEnvironment(projectId, environmentKey);
        String approvalExpectation = "PRODUCTION_DEPLOY remains REQUIRE_HUMAN: every run waits for a fresh operator approval.";
        if (project.getSourceType() != ProjectSourceType.GIT || blank(project.getRepositoryUrl())) {
            return fallback(project, environment, "Project is not a Git project with a repository URL", approvalExpectation);
        }
        String repository = GitHubManifestClient.repositoryPath(project.getRepositoryUrl());
        if (repository == null) {
            return fallback(project, environment, "Repository must be a github.com owner/repository URL", approvalExpectation);
        }
        String commitSha = client.resolveCommitSha(repository, project.getDefaultBranch(), projectService.githubToken(projectId));
        JsonNode manifest = client.fetchManifest(repository, commitSha, projectService.githubToken(projectId));
        if (manifest == null) {
            return withRepository(fallback(project, environment, "No " + MANIFEST_PATH + " at " + commitSha, approvalExpectation),
                    repository, commitSha);
        }
        try {
            ParsedRunbook parsed = parse(manifest, environment.getKey());
            List<OperationalRegistryService.StepSpec> steps = parsed.steps();
            // Validate through the registry rules so a repository manifest can never
            // register a step shape the API itself would reject.
            registry.validateSteps(projectId, environment.getId(), steps);
            return new Plan(projectId, Source.REPOSITORY_MANIFEST, MANIFEST_PATH, repository, commitSha, environment,
                    parsed.key(), parsed.action(), parsed.description(), steps, false, null, approvalExpectation);
        } catch (RuntimeException error) {
            return withRepository(fallback(project, environment, "Invalid " + MANIFEST_PATH + ": " + error.getMessage(), approvalExpectation),
                    repository, commitSha);
        }
    }

    private OperationalRunbookEntity upsert(Plan plan) {
        OperationalRunbookEntity saved = registry.runbookRepository().findByProjectIdAndKey(plan.projectId(), plan.runbookKey())
                .map(existing -> registry.updateRunbook(existing.getId(), plan.runbookKey(), plan.action(),
                        plan.description(), plan.steps(), true))
                .orElseGet(() -> registry.createRunbook(plan.projectId(), plan.environment().getId(), plan.runbookKey(),
                        plan.runbookKey(), plan.action(), plan.description(), plan.steps()));
        saved.recordSource("REPOSITORY_MANIFEST", plan.repository(), plan.commitSha(), MANIFEST_PATH);
        return registry.runbookRepository().save(saved);
    }

    private OperationalEnvironmentEntity resolveEnvironment(UUID projectId, String environmentKey) {
        if (!blank(environmentKey)) {
            return registry.environments(projectId).stream()
                    .filter(candidate -> candidate.getKey().equals(environmentKey.trim().toLowerCase(Locale.ROOT)))
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("Environment not found: " + environmentKey));
        }
        return registry.environments(projectId).stream()
                .filter(OperationalEnvironmentEntity::isEnabled)
                .filter(candidate -> candidate.getKind() == OperationalEnvironmentEntity.Kind.PRODUCTION)
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Project has no enabled production environment"));
    }

    private Plan fallback(ProjectEntity project, OperationalEnvironmentEntity environment, String reason, String approvalExpectation) {
        return new Plan(project.getId(), Source.HUMAN_GATED_FALLBACK, MANIFEST_PATH, null, null, environment,
                FALLBACK_KEY, "PRODUCTION_DEPLOY",
                "Human-gated deployment: the repository did not declare a usable " + MANIFEST_PATH
                        + " (" + reason + "). Evidence is supplied by the operator after the deployment.",
                List.of(), false, reason, approvalExpectation);
    }

    private ParsedRunbook parse(JsonNode manifest, String environmentKey) {
        if (!manifest.isObject()) throw new IllegalArgumentException("manifest must be a JSON object");
        int version = manifest.path("version").asInt(0);
        if (version != 1) throw new IllegalArgumentException("unsupported manifest version: " + version);
        String manifestEnvironment = text(manifest, "environment");
        if (!manifestEnvironment.equalsIgnoreCase(environmentKey)) {
            throw new IllegalArgumentException("manifest environment " + manifestEnvironment + " does not match " + environmentKey);
        }
        String action = text(manifest, "action").toUpperCase(Locale.ROOT);
        if (!action.equals("PRODUCTION_DEPLOY")) {
            throw new IllegalArgumentException("repository deployment manifest action must be PRODUCTION_DEPLOY");
        }
        JsonNode stepNodes = manifest.path("steps");
        if (!stepNodes.isArray() || stepNodes.isEmpty()) throw new IllegalArgumentException("manifest requires a non-empty steps array");
        List<OperationalRegistryService.StepSpec> steps = new ArrayList<>();
        for (JsonNode node : stepNodes) {
            if (!node.isObject()) throw new IllegalArgumentException("each step must be an object");
            OperationalRegistryService.StepType type;
            try {
                type = OperationalRegistryService.StepType.valueOf(text(node, "type").toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException error) {
                throw new IllegalArgumentException("unsupported step type: " + node.path("type").asText());
            }
            if (type == OperationalRegistryService.StepType.COMMAND) {
                throw new IllegalArgumentException("repository manifests may not declare COMMAND steps");
            }
            JsonNode config = node.path("config").isMissingNode() ? mapper.createObjectNode() : node.path("config");
            JsonNode inputs = config.path("inputs");
            if (inputs.isObject()) {
                inputs.properties().forEach(entry -> {
                    if (SECRET_INPUT.matcher(entry.getKey()).matches()) {
                        throw new IllegalArgumentException("repository manifests may not persist secret workflow input: " + entry.getKey());
                    }
                });
            }
            steps.add(new OperationalRegistryService.StepSpec(
                    text(node, "key"), text(node, "name"), type,
                    config.deepCopy(),
                    node.path("timeoutSeconds").asInt(120)));
        }
        return new ParsedRunbook("production-deploy", action, "Deployment runbook discovered from " + MANIFEST_PATH, steps);
    }

    private String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || !value.isTextual() || value.asText().isBlank()) {
            throw new IllegalArgumentException("manifest field " + field + " is required");
        }
        return value.asText().trim();
    }

    private boolean blank(String value) { return value == null || value.isBlank(); }

    private record ParsedRunbook(String key, String action, String description,
                                 List<OperationalRegistryService.StepSpec> steps) {}

    private Plan withRepository(Plan plan, String repository, String commitSha) {
        return new Plan(plan.projectId(), plan.source(), plan.manifestPath(), repository, commitSha, plan.environment(),
                plan.runbookKey(), plan.action(), plan.description(), plan.steps(), plan.registered(),
                plan.fallbackReason(), plan.approvalExpectation());
    }

    /** Reads the manifest from the exact commit, never from a mutable branch ref. */
    static class GitHubManifestClient {
        private static final Duration TIMEOUT = Duration.ofSeconds(20);
        private final AgenticformProperties.GitHub properties;
        private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

        GitHubManifestClient(AgenticformProperties.GitHub properties) { this.properties = properties; }

        static String repositoryPath(String repositoryUrl) {
            try {
                URI uri = URI.create(repositoryUrl.trim());
                if (!"github.com".equalsIgnoreCase(uri.getHost())) return null;
                String path = uri.getPath();
                if (path == null) return null;
                path = path.replaceAll("^/+|/+$", "").replaceFirst("\\.git$", "");
                String[] parts = path.split("/");
                return parts.length == 2 && !parts[0].isBlank() && !parts[1].isBlank() ? parts[0] + "/" + parts[1] : null;
            } catch (RuntimeException error) {
                return null;
            }
        }

        String resolveCommitSha(String repository, String ref, String token) {
            JsonNode body = get("repos/" + repository + "/commits/" + ref, token);
            String sha = body == null ? null : body.path("sha").asText(null);
            if (sha == null || sha.isBlank()) {
                throw new IllegalArgumentException("Unable to resolve " + ref + " for " + repository);
            }
            return sha;
        }

        JsonNode fetchManifest(String repository, String commitSha, String token) {
            String encoded = MANIFEST_PATH.replace("/", "%2F");
            return get("repos/" + repository + "/contents/" + encoded + "?ref=" + commitSha, token);
        }

        ObjectNode fetchEvidence(String repository, String sha, String token) {
            ObjectNode result = new ObjectMapper().createObjectNode();
            result.put("repository", repository); result.put("commitSha", sha);
            ArrayNode files = result.putArray("files");
            JsonNode tree = get("repos/" + repository + "/git/trees/" + sha + "?recursive=1", token);
            List<String> paths = new ArrayList<>();
            if (tree != null && tree.path("tree").isArray()) for (JsonNode item : tree.path("tree")) {
                String path = item.path("path").asText("");
                if ((path.startsWith(".github/workflows/") || path.startsWith(".agenticform/") || path.startsWith("runbook/")) && path.endsWith(".md")
                        || path.startsWith(".github/workflows/") && path.endsWith(".yml")
                        || path.startsWith(".github/workflows/") && path.endsWith(".yaml")
                        || path.equals("Dockerfile") || path.equals("docker-compose.yml") || path.equals("compose.yaml") || path.equals("Makefile")) paths.add(path);
            }
            paths.stream().distinct().sorted().limit(20).forEach(path -> {
                String content = getTextContent("repos/" + repository + "/contents/" + path.replace("/", "%2F") + "?ref=" + sha, token);
                if (content != null) {
                    if (content.length() > 12000) content = content.substring(0, 12000);
                    files.addObject().put("path", path).put("content", content);
                }
            });
            return result;
        }

        private String getTextContent(String path, String token) {
            JsonNode wrapper = getRawJson(path, token);
            if (wrapper == null || !wrapper.hasNonNull("content")) return null;
            try { return new String(Base64.getDecoder().decode(wrapper.path("content").asText().replaceAll("\s", "")), java.nio.charset.StandardCharsets.UTF_8); }
            catch (IllegalArgumentException error) { return null; }
        }

        private JsonNode getRawJson(String path, String token) {
            URI base = properties.getApiUrl();
            String root = base.toString().endsWith("/") ? base.toString() : base + "/";
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(root + path)).timeout(TIMEOUT)
                    .header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28").GET();
            String credential = firstNonBlank(token, properties.getToken());
            if (credential != null) builder.header("Authorization", "Bearer " + credential);
            try {
                HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 404) return null;
                if (response.statusCode() != 200) throw new IllegalArgumentException("GitHub read failed (HTTP " + response.statusCode() + ") for " + path);
                return new ObjectMapper().readTree(response.body());
            } catch (IllegalArgumentException error) { throw error; }
            catch (Exception error) { throw new IllegalStateException("Unable to read " + path + " from GitHub", error); }
        }

        String createBranch(String repository, String branch, String sha, String token) {
            ObjectNode body = new ObjectMapper().createObjectNode().put("ref", "refs/heads/" + branch).put("sha", sha);
            return post("repos/" + repository + "/git/refs", body, token).path("ref").asText();
        }

        void createFile(String repository, String branch, String content, String token) {
            ObjectNode body = new ObjectMapper().createObjectNode().put("message", "docs: add deployment runbook manifest")
                    .put("content", Base64.getEncoder().encodeToString(content.getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                    .put("branch", branch);
            post("repos/" + repository + "/contents/" + MANIFEST_PATH.replace("/", "%2F"), body, token);
        }

        ObjectNode createPullRequest(String repository, String head, String base, String title, String bodyText, String token) {
            ObjectNode body = new ObjectMapper().createObjectNode().put("title", title).put("head", head).put("base", base).put("body", bodyText);
            return (ObjectNode) post("repos/" + repository + "/pulls", body, token);
        }

        private JsonNode post(String path, JsonNode payload, String token) {
            URI base = properties.getApiUrl();
            String root = base.toString().endsWith("/") ? base.toString() : base + "/";
            String credential = firstNonBlank(token, properties.getToken());
            if (credential == null) throw new IllegalArgumentException("GitHub token required to open runbook proposal PR");
            HttpRequest request = HttpRequest.newBuilder(URI.create(root + path)).timeout(TIMEOUT)
                    .header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28")
                    .header("Authorization", "Bearer " + credential).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload.toString())).build();
            try {
                HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() < 200 || response.statusCode() >= 300)
                    throw new IllegalArgumentException("GitHub write failed (HTTP " + response.statusCode() + ") for " + path);
                return new ObjectMapper().readTree(response.body());
            } catch (IllegalArgumentException error) { throw error; }
            catch (Exception error) { throw new IllegalStateException("Unable to write " + path + " to GitHub", error); }
        }

        private JsonNode get(String path, String token) {
            URI base = properties.getApiUrl();
            String root = base.toString().endsWith("/") ? base.toString() : base + "/";
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(root + path))
                    .timeout(TIMEOUT)
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .GET();
            String credential = firstNonBlank(token, properties.getToken());
            if (credential != null) builder.header("Authorization", "Bearer " + credential);
            try {
                HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 404) return null;
                if (response.statusCode() == 401 || response.statusCode() == 403) {
                    throw new IllegalArgumentException("GitHub authentication failed reading " + path);
                }
                if (response.statusCode() != 200) {
                    throw new IllegalArgumentException("GitHub read failed (HTTP " + response.statusCode() + ") for " + path);
                }
                return decode(response.body());
            } catch (IllegalArgumentException error) {
                throw error;
            } catch (Exception error) {
                throw new IllegalStateException("Unable to read " + path + " from GitHub", error);
            }
        }

        private JsonNode decode(String body) {
            ObjectMapper local = new ObjectMapper();
            JsonNode node = local.readTree(body);
            if (node == null) return null;
            if (node.isObject() && node.hasNonNull("content")) {
                String content = node.get("content").asText().replaceAll("\\s", "");
                byte[] decoded = java.util.Base64.getDecoder().decode(content);
                return local.readTree(new String(decoded, java.nio.charset.StandardCharsets.UTF_8));
            }
            return node;
        }

        private String firstNonBlank(String... values) {
            for (String value : values) if (value != null && !value.isBlank()) return value.trim();
            return null;
        }
    }
}
