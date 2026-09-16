package com.agenticform.operation;

import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectRepository;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class RunbookExecutor {
    private record StepOutcome(String summary, String evidence, Integer exitCode) {}
    private record CommandResult(int exitCode, String output) {}

    private static final int MAX_EVIDENCE_BYTES = 16 * 1024;
    private static final Pattern PARAMETER = Pattern.compile("\\$\\{param:([A-Za-z0-9_.-]+)}");
    private static final Pattern SECRET = Pattern.compile(
            "(?i)(authorization\\s*:?\\s*bearer|token|password|secret|api[_-]?key)(\\s*[=:]\\s*|\\s+)[^\\s]+"
    );
    private static final Set<String> SHELL_INTERPRETERS = Set.of(
            "sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"
    );

    private final OperationRunRepository runRepository;
    private final OperationStepRunRepository stepRepository;
    private final ProjectRepository projectRepository;
    private final OperationalRegistryService registry;
    private final ExternalWorkflowService externalWorkflows;
    private final OperationEventService events;
    private final ObjectMapper mapper;
    private final HttpClient httpClient;
    private final com.agenticform.task.TaskRepository taskRepository;

    public RunbookExecutor(OperationRunRepository runRepository,
                           OperationStepRunRepository stepRepository,
                           ProjectRepository projectRepository,
                           OperationalRegistryService registry,
                           ExternalWorkflowService externalWorkflows,
                           OperationEventService events,
                           ObjectMapper mapper,
                           com.agenticform.task.TaskRepository taskRepository) {
        this.runRepository = runRepository;
        this.stepRepository = stepRepository;
        this.projectRepository = projectRepository;
        this.registry = registry;
        this.externalWorkflows = externalWorkflows;
        this.events = events;
        this.mapper = mapper;
        this.taskRepository = taskRepository;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    public void execute(UUID runId) {
        OperationRunEntity run = runRepository.findById(runId)
                .orElseThrow(() -> new NoSuchElementException("Operation run not found: " + runId));
        if (run.getStatus() != OperationRunEntity.Status.QUEUED) return;

        run.start();
        runRepository.save(run);

        try {
            ProjectEntity project = projectRepository.findById(run.getProjectId())
                    .orElseThrow(() -> new NoSuchElementException("Project not found: " + run.getProjectId()));
            Path projectRoot = Path.of(project.getRootDirectory()).toRealPath();
            JsonNode snapshot = mapper.readTree(run.getRunbookSnapshot());
            List<OperationalRegistryService.StepSpec> steps = registry.decodeSteps(
                    mapper.writeValueAsString(snapshot.path("steps")));
            Map<String, String> parameters = decodeParameters(run.getParametersJson());

            for (int position = 0; position < steps.size(); position++) {
                OperationalRegistryService.StepSpec step = steps.get(position);
                var existing = stepRepository.findByOperationRunIdAndPosition(run.getId(), position);
                if (existing.isPresent()) {
                    OperationStepRunEntity previous = existing.get();
                    if (previous.getStatus() == OperationStepRunEntity.Status.SUCCEEDED) continue;
                    if (previous.getStatus() == OperationStepRunEntity.Status.WAITING_EXTERNAL) {
                        run.waitExternal();
                        runRepository.save(run);
                        return;
                    }
                    if (previous.getStatus() == OperationStepRunEntity.Status.FAILED) {
                        run.fail("Step " + step.key() + " is already failed: " + previous.getSummary());
                        runRepository.save(run);
                        events.publishTerminal(run);
                        return;
                    }
                    throw new IllegalStateException("Step " + step.key() + " was left RUNNING and cannot be replayed safely");
                }

                OperationStepRunEntity stepRun = stepRepository.save(new OperationStepRunEntity(
                        run.getId(), step.key(), step.name(), step.type().name(), position));
                long started = System.nanoTime();
                try {
                    if (step.type() == OperationalRegistryService.StepType.GITHUB_WORKFLOW) {
                        beginGitHubWorkflow(run, stepRun, step, parameters);
                        return;
                    }
                    StepOutcome outcome = executeStep(step, snapshot, parameters, projectRoot);
                    stepRun.succeed(outcome.summary(), outcome.evidence(), outcome.exitCode(), elapsedMillis(started));
                    stepRepository.save(stepRun);
                } catch (Exception error) {
                    String message = safeMessage(error);
                    stepRun.fail(message, null, null, elapsedMillis(started));
                    stepRepository.save(stepRun);
                    run.fail("Step " + step.key() + " failed: " + message);
                    runRepository.save(run);
                    events.publishTerminal(run);
                    return;
                }
            }

            run.succeed();
            markRootDeliveredIfDeployment(run);
            runRepository.save(run);
            events.publishTerminal(run);
        } catch (Exception error) {
            run.fail(safeMessage(error));
            runRepository.save(run);
            events.publishTerminal(run);
        }
    }

    /**
     * A successful deployment runbook with recorded post-deployment verification is
     * the authoritative delivery proof for the root task that requested it. Other
     * operations (inspection, rollback) never mark the requested change delivered.
     */
    private void markRootDeliveredIfDeployment(OperationRunEntity run) {
        if (run.getRequestedTaskId() == null) return;
        if (!isDeploymentAction(run.getAction())) return;
        var task = taskRepository.findById(run.getRequestedTaskId()).orElse(null);
        if (task == null || !task.requiresVerifiedDelivery()) return;
        String verification = deploymentVerificationEvidence(run.getId());
        if (verification == null) return;
        String revision = expectedRevision(run);
        // Evidence must be bound to the exact accepted revision and target. A green
        // run for an unidentified revision cannot prove delivery.
        if (revision == null || run.getEnvironmentKey() == null || run.getEnvironmentKey().isBlank()) return;
        task.setDeliveryStage(com.agenticform.task.TaskDeliveryStage.DEPLOYMENT_VERIFIED);
        task.recordVerifiedDelivery(run.getEnvironmentKey(), revision, artifactDigest(run),
                run.getId(), verification);
        taskRepository.save(task);
    }

    private String expectedRevision(OperationRunEntity run) {
        Map<String, String> parameters = safeParameters(run.getParametersJson());
        for (String key : List.of("expectedSha", "expected_sha", "sha", "revision", "commit", "version")) {
            String value = parameters.get(key);
            if (value != null && !value.isBlank()) return value.trim();
        }
        return null;
    }

    private String artifactDigest(OperationRunEntity run) {
        Map<String, String> parameters = safeParameters(run.getParametersJson());
        for (String key : List.of("digest", "imageDigest", "artifactDigest", "artifact")) {
            String value = parameters.get(key);
            if (value != null && !value.isBlank()) return value.trim();
        }
        return null;
    }

    private Map<String, String> safeParameters(String json) {
        try {
            return decodeParameters(json);
        } catch (Exception error) {
            return Map.of();
        }
    }

    private boolean isDeploymentAction(String action) {
        if (action == null) return false;
        String normalized = action.toLowerCase(java.util.Locale.ROOT);
        return normalized.contains("deploy") || normalized.contains("release");
    }

    private String deploymentVerificationEvidence(java.util.UUID runId) {
        StringBuilder evidence = new StringBuilder();
        for (OperationStepRunEntity step : stepRepository.findAllByOperationRunIdOrderByPosition(runId)) {
            if (step.getStatus() != OperationStepRunEntity.Status.SUCCEEDED) return null;
            String type = step.getStepType();
            if (type == null) return null;
            if (type.contains("CHECK") || type.contains("ASSERT")) {
                if (step.getEvidence() == null || step.getEvidence().isBlank()) return null;
                evidence.append(step.getStepKey()).append(": ").append(step.getEvidence()).append('\n');
            }
        }
        return evidence.isEmpty() ? null : evidence.toString();
    }

    private StepOutcome executeStep(OperationalRegistryService.StepSpec step,
                                    JsonNode snapshot,
                                    Map<String, String> parameters,
                                    Path projectRoot) throws Exception {
        JsonNode config = step.config();
        return switch (step.type()) {
            case ASSERT_GIT_CLEAN -> assertGitClean(projectRoot, step.timeoutSeconds());
            case ASSERT_GIT_SHA -> assertGitSha(projectRoot, substitute(config.path("expected").asText(), parameters), step.timeoutSeconds());
            case COMMAND -> executeConfiguredCommand(projectRoot, config, parameters, step.timeoutSeconds());
            case HTTP_CHECK -> httpCheck(substitute(config.path("url").asText(), parameters), config, step.timeoutSeconds());
            case SERVICE_CHECK -> serviceCheck(snapshot, config, step.timeoutSeconds());
            case GITHUB_WORKFLOW -> throw new IllegalStateException("GITHUB_WORKFLOW must use durable external execution");
        };
    }

    private void beginGitHubWorkflow(OperationRunEntity run, OperationStepRunEntity stepRun,
                                     OperationalRegistryService.StepSpec step,
                                     Map<String, String> parameters) throws Exception {
        JsonNode config = step.config();
        String mode = config.path("mode").asText("WAIT").toUpperCase(Locale.ROOT);
        String repository = config.path("repository").asText();
        String workflow = config.path("workflow").asText();
        String ref = substitute(config.path("ref").asText(), parameters);
        String expectedHeadSha = mode.equals("WAIT")
                ? substitute(config.path("headSha").asText(), parameters)
                : substitute(config.path("expectedHeadSha").asText(), parameters);
        Map<String, String> inputs = new LinkedHashMap<>();
        JsonNode inputNode = config.path("inputs");
        if (inputNode.isObject()) {
            inputNode.properties().forEach(entry -> inputs.put(entry.getKey(), substitute(entry.getValue().asText(), parameters)));
        }
        externalWorkflows.begin(run, stepRun, new ExternalWorkflowService.BeginRequest(
                mode, repository, workflow, ref, expectedHeadSha, Map.copyOf(inputs), step.timeoutSeconds()));
    }

    private StepOutcome assertGitClean(Path root, int timeoutSeconds) throws Exception {
        CommandResult result = runCommand(root, List.of("git", "status", "--porcelain"), timeoutSeconds, true);
        if (result.exitCode() != 0) throw new IllegalStateException("git status exited with " + result.exitCode());
        if (!result.output().isBlank()) throw new IllegalStateException("deployment worktree is not clean");
        return new StepOutcome("Git worktree is clean", null, 0);
    }

    private StepOutcome assertGitSha(Path root, String expected, int timeoutSeconds) throws Exception {
        CommandResult result = runCommand(root, List.of("git", "rev-parse", "HEAD"), timeoutSeconds, true);
        if (result.exitCode() != 0) throw new IllegalStateException("git rev-parse exited with " + result.exitCode());
        String actual = result.output().trim();
        if (!actual.equals(expected)) throw new IllegalStateException("Git SHA mismatch: expected " + expected + " but found " + actual);
        return new StepOutcome("Git SHA matches requested release", actual, 0);
    }

    private StepOutcome executeConfiguredCommand(Path projectRoot, JsonNode config,
                                                 Map<String, String> parameters, int timeoutSeconds) throws Exception {
        List<String> argv = new ArrayList<>();
        for (JsonNode arg : config.path("argv")) argv.add(substitute(arg.asText(), parameters));
        Path cwd = resolveWorkingDirectory(projectRoot, substitute(config.path("cwd").asText("."), parameters));
        boolean capture = config.path("captureOutput").asBoolean(false);
        CommandResult result = runCommand(cwd, argv, timeoutSeconds, capture);
        if (result.exitCode() != 0) {
            String suffix = result.output().isBlank() ? "" : ": " + singleLine(result.output());
            throw new IllegalStateException("Command exited with " + result.exitCode() + suffix);
        }
        return new StepOutcome("Command completed successfully", capture ? result.output() : null, result.exitCode());
    }

    private StepOutcome httpCheck(String rawUrl, JsonNode config, int timeoutSeconds) throws Exception {
        URI uri = URI.create(rawUrl);
        requireHttp(uri);
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .GET()
                .build();
        HttpResponse<Void> response = httpClient.send(request, HttpResponse.BodyHandlers.discarding());
        int min = config.path("minStatus").asInt(200);
        int max = config.path("maxStatus").asInt(299);
        if (response.statusCode() < min || response.statusCode() > max) {
            throw new IllegalStateException("HTTP check returned " + response.statusCode());
        }
        return new StepOutcome("HTTP check returned " + response.statusCode(), safeUri(uri), null);
    }

    private StepOutcome serviceCheck(JsonNode snapshot, JsonNode config, int timeoutSeconds) throws Exception {
        String serviceKey = config.path("service").asText();
        String probe = config.path("probe").asText("health").toLowerCase(Locale.ROOT);
        JsonNode service = snapshot.path("services").path(serviceKey);
        if (service.isMissingNode()) throw new IllegalStateException("Service is missing from immutable operation snapshot: " + serviceKey);
        String field = probe.equals("readiness") ? "readinessUrl" : "healthUrl";
        String url = service.path(field).asText();
        if (url.isBlank()) throw new IllegalStateException("Service snapshot has no " + probe + " URL: " + serviceKey);
        return httpCheck(url, config, timeoutSeconds);
    }

    private CommandResult runCommand(Path cwd, List<String> argv, int timeoutSeconds, boolean captureOutput) throws Exception {
        if (argv == null || argv.isEmpty()) throw new IllegalArgumentException("Command argv is empty");
        String executable = Path.of(argv.get(0)).getFileName().toString().toLowerCase(Locale.ROOT);
        if (SHELL_INTERPRETERS.contains(executable)) {
            throw new IllegalArgumentException("Shell interpreters are not allowed in deterministic COMMAND steps: " + executable);
        }

        Path output = Files.createTempFile("agenticform-operation-", ".log");
        try {
            ProcessBuilder builder = new ProcessBuilder(argv);
            builder.directory(cwd.toFile());
            builder.redirectErrorStream(true);
            builder.redirectOutput(output.toFile());
            Process process = builder.start();
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
                throw new IllegalStateException("Command timed out after " + timeoutSeconds + " seconds");
            }
            String captured = captureOutput ? redact(readBounded(output)) : "";
            return new CommandResult(process.exitValue(), captured);
        } finally {
            Files.deleteIfExists(output);
        }
    }

    private Path resolveWorkingDirectory(Path projectRoot, String configured) throws Exception {
        Path candidate = Path.of(configured);
        if (!candidate.isAbsolute()) candidate = projectRoot.resolve(candidate);
        Path real = candidate.normalize().toRealPath();
        if (!real.startsWith(projectRoot)) throw new IllegalArgumentException("Command working directory escapes project root");
        return real;
    }

    private Map<String, String> decodeParameters(String json) throws Exception {
        JsonNode node = mapper.readTree(json);
        Map<String, String> result = new HashMap<>();
        if (node != null && node.isObject()) {
            node.properties().forEach(entry -> {
                if (!entry.getValue().isTextual()) throw new IllegalArgumentException("Operation parameters must be strings");
                result.put(entry.getKey(), entry.getValue().asText());
            });
        }
        return Map.copyOf(result);
    }

    private String substitute(String value, Map<String, String> parameters) {
        Matcher matcher = PARAMETER.matcher(value == null ? "" : value);
        StringBuffer output = new StringBuffer();
        while (matcher.find()) {
            String name = matcher.group(1);
            String replacement = parameters.get(name);
            if (replacement == null) throw new IllegalArgumentException("Missing operation parameter: " + name);
            matcher.appendReplacement(output, Matcher.quoteReplacement(replacement));
        }
        matcher.appendTail(output);
        return output.toString();
    }

    private String readBounded(Path path) throws Exception {
        try (InputStream input = Files.newInputStream(path); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[2048];
            int remaining = MAX_EVIDENCE_BYTES;
            while (remaining > 0) {
                int read = input.read(buffer, 0, Math.min(buffer.length, remaining));
                if (read < 0) break;
                output.write(buffer, 0, read);
                remaining -= read;
            }
            String text = output.toString(StandardCharsets.UTF_8);
            if (input.read() >= 0) text += "\n[output truncated]";
            return text;
        }
    }

    private String redact(String value) {
        return SECRET.matcher(value == null ? "" : value).replaceAll("$1$2[REDACTED]");
    }

    private void requireHttp(URI uri) {
        String scheme = uri.getScheme();
        if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))) {
            throw new IllegalArgumentException("HTTP checks require http or https URL");
        }
        if (uri.getHost() == null) throw new IllegalArgumentException("HTTP check URL requires a host");
    }

    private String safeUri(URI uri) {
        String authority = uri.getRawAuthority();
        String path = uri.getRawPath();
        return uri.getScheme() + "://" + authority + (path == null ? "" : path);
    }

    private long elapsedMillis(long startedNanos) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
    }

    private String safeMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) message = error.getClass().getSimpleName();
        return redact(message.length() > 2000 ? message.substring(0, 2000) : message);
    }

    private String singleLine(String value) {
        String normalized = value.replace('\r', ' ').replace('\n', ' ').trim();
        return normalized.length() > 400 ? normalized.substring(0, 400) + "…" : normalized;
    }
}
