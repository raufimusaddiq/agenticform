package com.agenticform.operation;

import com.agenticform.policy.DeterministicPolicyEngine;
import com.agenticform.project.ProjectRepository;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.NoSuchElementException;
import java.util.UUID;
import java.util.regex.Pattern;

@Service
public class OperationalRegistryService {
    public enum StepType {
        ASSERT_GIT_CLEAN,
        ASSERT_GIT_SHA,
        COMMAND,
        HTTP_CHECK,
        SERVICE_CHECK,
        GITHUB_WORKFLOW
    }

    public record StepSpec(String key, String name, StepType type, JsonNode config, int timeoutSeconds) {}

    private static final Pattern KEY = Pattern.compile("[a-z0-9][a-z0-9_-]{0,63}");
    private static final Pattern GITHUB_REPOSITORY = Pattern.compile("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+");
    private static final Pattern GITHUB_WORKFLOW = Pattern.compile("[A-Za-z0-9_.-]+(?:\\.ya?ml)?");
    private static final int DEFAULT_TIMEOUT_SECONDS = 120;
    private static final int MAX_TIMEOUT_SECONDS = 3600;

    private final ProjectRepository projectRepository;
    private final OperationalEnvironmentRepository environmentRepository;
    private final OperationalServiceRepository serviceRepository;
    private final OperationalRunbookRepository runbookRepository;
    private final DeterministicPolicyEngine policyEngine;
    private final ObjectMapper mapper;

    public OperationalRegistryService(ProjectRepository projectRepository,
                                      OperationalEnvironmentRepository environmentRepository,
                                      OperationalServiceRepository serviceRepository,
                                      OperationalRunbookRepository runbookRepository,
                                      DeterministicPolicyEngine policyEngine,
                                      ObjectMapper mapper) {
        this.projectRepository = projectRepository;
        this.environmentRepository = environmentRepository;
        this.serviceRepository = serviceRepository;
        this.runbookRepository = runbookRepository;
        this.policyEngine = policyEngine;
        this.mapper = mapper;
    }

    public List<OperationalEnvironmentEntity> environments(UUID projectId) {
        return projectId == null ? environmentRepository.findAll() : environmentRepository.findAllByProjectIdOrderByKey(projectId);
    }

    public OperationalEnvironmentEntity createEnvironment(UUID projectId, String key, String displayName,
                                                          OperationalEnvironmentEntity.Kind kind) {
        requireProject(projectId);
        String normalizedKey = normalizeKey(key);
        if (environmentRepository.existsByProjectIdAndKey(projectId, normalizedKey)) {
            throw new IllegalArgumentException("Environment already exists: " + normalizedKey);
        }
        if (displayName == null || displayName.isBlank()) throw new IllegalArgumentException("Environment display name is required");
        if (kind == null) throw new IllegalArgumentException("Environment kind is required");
        return environmentRepository.save(new OperationalEnvironmentEntity(projectId, normalizedKey, displayName.trim(), kind));
    }

    public OperationalEnvironmentEntity updateEnvironment(UUID id, String displayName,
                                                          OperationalEnvironmentEntity.Kind kind, boolean enabled) {
        OperationalEnvironmentEntity environment = environment(id);
        if (displayName == null || displayName.isBlank()) throw new IllegalArgumentException("Environment display name is required");
        if (kind == null) throw new IllegalArgumentException("Environment kind is required");
        environment.update(displayName.trim(), kind, enabled);
        return environmentRepository.save(environment);
    }

    public List<OperationalServiceEntity> services(UUID projectId) {
        return projectId == null ? serviceRepository.findAll() : serviceRepository.findAllByProjectIdOrderByEnvironmentIdAscKeyAsc(projectId);
    }

    public OperationalServiceEntity createService(UUID projectId, UUID environmentId, String key, String displayName,
                                                  String healthUrl, String readinessUrl) {
        requireProject(projectId);
        OperationalEnvironmentEntity environment = environment(environmentId);
        requireSameProject(projectId, environment.getProjectId(), "environment");
        String normalizedKey = normalizeKey(key);
        if (serviceRepository.existsByEnvironmentIdAndKey(environmentId, normalizedKey)) {
            throw new IllegalArgumentException("Service already exists in environment: " + normalizedKey);
        }
        if (displayName == null || displayName.isBlank()) throw new IllegalArgumentException("Service display name is required");
        validateUrl(healthUrl, "healthUrl");
        validateUrl(readinessUrl, "readinessUrl");
        return serviceRepository.save(new OperationalServiceEntity(projectId, environmentId, normalizedKey,
                displayName.trim(), blankToNull(healthUrl), blankToNull(readinessUrl)));
    }

    public OperationalServiceEntity updateService(UUID id, String displayName, String healthUrl,
                                                  String readinessUrl, boolean enabled) {
        OperationalServiceEntity service = service(id);
        if (displayName == null || displayName.isBlank()) throw new IllegalArgumentException("Service display name is required");
        validateUrl(healthUrl, "healthUrl");
        validateUrl(readinessUrl, "readinessUrl");
        service.update(displayName.trim(), blankToNull(healthUrl), blankToNull(readinessUrl), enabled);
        return serviceRepository.save(service);
    }

    public List<OperationalRunbookEntity> runbooks(UUID projectId) {
        return projectId == null ? runbookRepository.findAll() : runbookRepository.findAllByProjectIdOrderByKey(projectId);
    }

    public OperationalRunbookEntity createRunbook(UUID projectId, UUID environmentId, String key, String name,
                                                  String action, String description, List<StepSpec> steps) {
        requireProject(projectId);
        OperationalEnvironmentEntity environment = environment(environmentId);
        requireSameProject(projectId, environment.getProjectId(), "environment");
        String normalizedKey = normalizeKey(key);
        if (runbookRepository.existsByProjectIdAndKey(projectId, normalizedKey)) {
            throw new IllegalArgumentException("Runbook already exists: " + normalizedKey);
        }
        String normalizedAction = policyEngine.normalizeAction(action);
        requireRunbookText(name, description, normalizedAction);
        String definition = encodeSteps(projectId, environmentId, steps);
        return runbookRepository.save(new OperationalRunbookEntity(projectId, environmentId, normalizedKey,
                name.trim(), normalizedAction, description.trim(), definition));
    }

    public OperationalRunbookEntity updateRunbook(UUID id, String name, String action, String description,
                                                  List<StepSpec> steps, boolean enabled) {
        OperationalRunbookEntity runbook = runbook(id);
        String normalizedAction = policyEngine.normalizeAction(action);
        requireRunbookText(name, description, normalizedAction);
        String definition = encodeSteps(runbook.getProjectId(), runbook.getEnvironmentId(), steps);
        runbook.update(name.trim(), normalizedAction, description.trim(), definition, enabled);
        return runbookRepository.save(runbook);
    }

    public OperationalRunbookEntity runbook(UUID id) {
        return runbookRepository.findById(id).orElseThrow(() -> new NoSuchElementException("Runbook not found: " + id));
    }

    public OperationalRunbookEntity runbook(UUID projectId, String key) {
        return runbookRepository.findByProjectIdAndKey(projectId, normalizeKey(key))
                .orElseThrow(() -> new NoSuchElementException("Runbook not found in project: " + key));
    }

    public OperationalEnvironmentEntity environment(UUID id) {
        return environmentRepository.findById(id).orElseThrow(() -> new NoSuchElementException("Environment not found: " + id));
    }

    public OperationalServiceEntity service(UUID id) {
        return serviceRepository.findById(id).orElseThrow(() -> new NoSuchElementException("Service not found: " + id));
    }

    public OperationalServiceEntity service(UUID environmentId, String key) {
        return serviceRepository.findByEnvironmentIdAndKey(environmentId, normalizeKey(key))
                .orElseThrow(() -> new NoSuchElementException("Service not found in environment: " + key));
    }

    public List<StepSpec> decodeSteps(String definitionJson) {
        try {
            JsonNode node = mapper.readTree(definitionJson);
            if (!node.isArray()) throw new IllegalArgumentException("Runbook definition must be an array");
            List<StepSpec> result = new ArrayList<>();
            for (JsonNode item : node) {
                result.add(new StepSpec(
                        item.path("key").asText(),
                        item.path("name").asText(),
                        StepType.valueOf(item.path("type").asText()),
                        item.path("config").deepCopy(),
                        item.path("timeoutSeconds").asInt(DEFAULT_TIMEOUT_SECONDS)
                ));
            }
            return List.copyOf(result);
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("Unable to decode persisted runbook definition", error);
        }
    }

    private String encodeSteps(UUID projectId, UUID environmentId, List<StepSpec> steps) {
        if (steps == null || steps.isEmpty()) throw new IllegalArgumentException("Runbook requires at least one step");
        ArrayNode array = mapper.createArrayNode();
        int position = 0;
        for (StepSpec step : steps) {
            validateStep(projectId, environmentId, step, position++);
            ObjectNode item = array.addObject();
            item.put("key", normalizeKey(step.key()));
            item.put("name", step.name().trim());
            item.put("type", step.type().name());
            item.set("config", step.config() == null || step.config().isNull() ? mapper.createObjectNode() : step.config().deepCopy());
            item.put("timeoutSeconds", normalizedTimeout(step.timeoutSeconds()));
        }
        try {
            return mapper.writeValueAsString(array);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to serialize runbook definition", error);
        }
    }

    private void validateStep(UUID projectId, UUID environmentId, StepSpec step, int position) {
        if (step == null) throw new IllegalArgumentException("Runbook step " + position + " is required");
        normalizeKey(step.key());
        if (step.name() == null || step.name().isBlank()) throw new IllegalArgumentException("Runbook step name is required");
        if (step.type() == null) throw new IllegalArgumentException("Runbook step type is required");
        normalizedTimeout(step.timeoutSeconds());
        JsonNode config = step.config() == null || step.config().isNull() ? mapper.createObjectNode() : step.config();
        if (!config.isObject()) throw new IllegalArgumentException("Step config must be an object for " + step.key());

        switch (step.type()) {
            case ASSERT_GIT_CLEAN -> { }
            case ASSERT_GIT_SHA -> requireText(config, "expected", step.key());
            case COMMAND -> {
                JsonNode argv = config.path("argv");
                if (!argv.isArray() || argv.isEmpty()) throw new IllegalArgumentException("COMMAND step requires non-empty config.argv array: " + step.key());
                for (JsonNode arg : argv) {
                    if (!arg.isTextual() || arg.asText().isBlank()) throw new IllegalArgumentException("COMMAND argv values must be non-empty strings: " + step.key());
                }
                if (config.hasNonNull("cwd") && !config.get("cwd").isTextual()) throw new IllegalArgumentException("COMMAND config.cwd must be a string: " + step.key());
            }
            case HTTP_CHECK -> validateUrl(requireText(config, "url", step.key()), "step url");
            case SERVICE_CHECK -> {
                String serviceKey = requireText(config, "service", step.key());
                OperationalServiceEntity service = service(environmentId, serviceKey);
                requireSameProject(projectId, service.getProjectId(), "service");
                String probe = config.path("probe").asText("health").toLowerCase(Locale.ROOT);
                if (!probe.equals("health") && !probe.equals("readiness")) {
                    throw new IllegalArgumentException("SERVICE_CHECK probe must be health or readiness: " + step.key());
                }
                String url = probe.equals("health") ? service.getHealthUrl() : service.getReadinessUrl();
                if (url == null || url.isBlank()) throw new IllegalArgumentException("Service " + serviceKey + " has no " + probe + " URL");
            }
            case GITHUB_WORKFLOW -> validateGitHubWorkflowStep(config, step.key());
        }
    }

    private void validateGitHubWorkflowStep(JsonNode config, String stepKey) {
        String repository = requireText(config, "repository", stepKey);
        if (!GITHUB_REPOSITORY.matcher(repository).matches()) {
            throw new IllegalArgumentException("GITHUB_WORKFLOW repository must be owner/name: " + stepKey);
        }
        String workflow = requireText(config, "workflow", stepKey);
        if (!GITHUB_WORKFLOW.matcher(workflow).matches()) {
            throw new IllegalArgumentException("GITHUB_WORKFLOW workflow must be a workflow file name or id: " + stepKey);
        }
        requireText(config, "ref", stepKey);
        String mode = config.path("mode").asText("WAIT").toUpperCase(Locale.ROOT);
        if (!mode.equals("WAIT") && !mode.equals("DISPATCH")) {
            throw new IllegalArgumentException("GITHUB_WORKFLOW mode must be WAIT or DISPATCH: " + stepKey);
        }
        if (mode.equals("WAIT")) requireText(config, "headSha", stepKey);
        JsonNode inputs = config.path("inputs");
        if (!inputs.isMissingNode() && !inputs.isObject()) {
            throw new IllegalArgumentException("GITHUB_WORKFLOW config.inputs must be an object: " + stepKey);
        }
        if (inputs.isObject()) {
            inputs.properties().forEach(entry -> {
                if (!entry.getValue().isTextual()) {
                    throw new IllegalArgumentException("GITHUB_WORKFLOW input values must be strings: " + stepKey);
                }
            });
        }
    }

    private void requireProject(UUID projectId) {
        if (projectId == null || !projectRepository.existsById(projectId)) throw new NoSuchElementException("Project not found: " + projectId);
    }

    private void requireSameProject(UUID expected, UUID actual, String subject) {
        if (!expected.equals(actual)) throw new IllegalArgumentException("Selected " + subject + " belongs to another project");
    }

    private void requireRunbookText(String name, String description, String action) {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("Runbook name is required");
        if (description == null || description.isBlank()) throw new IllegalArgumentException("Runbook description is required");
        if ("*".equals(action)) throw new IllegalArgumentException("Runbook action must be explicit");
    }

    private String requireText(JsonNode node, String field, String stepKey) {
        if (!node.hasNonNull(field) || !node.get(field).isTextual() || node.get(field).asText().isBlank()) {
            throw new IllegalArgumentException("Step " + stepKey + " requires config." + field);
        }
        return node.get(field).asText().trim();
    }

    private int normalizedTimeout(int timeoutSeconds) {
        int value = timeoutSeconds <= 0 ? DEFAULT_TIMEOUT_SECONDS : timeoutSeconds;
        if (value > MAX_TIMEOUT_SECONDS) throw new IllegalArgumentException("Step timeout may not exceed " + MAX_TIMEOUT_SECONDS + " seconds");
        return value;
    }

    public String normalizeKey(String value) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Key is required");
        String normalized = value.trim().toLowerCase(Locale.ROOT).replace(' ', '-');
        if (!KEY.matcher(normalized).matches()) throw new IllegalArgumentException("Invalid key: " + value);
        return normalized;
    }

    private void validateUrl(String url, String field) {
        if (url == null || url.isBlank()) return;
        String normalized = url.trim().toLowerCase(Locale.ROOT);
        if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
            throw new IllegalArgumentException(field + " must use http or https");
        }
    }

    private String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
