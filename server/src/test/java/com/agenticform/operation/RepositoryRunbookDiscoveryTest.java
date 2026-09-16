package com.agenticform.operation;

import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectRepository;
import com.agenticform.project.ProjectService;
import com.agenticform.project.ProjectSourceType;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class RepositoryRunbookDiscoveryTest {
    private static final String SHA = "a".repeat(40);

    private final ProjectRepository projects = mock(ProjectRepository.class);
    private final ProjectService projectService = mock(ProjectService.class);
    private final OperationalRegistryService registry = mock(OperationalRegistryService.class);
    private final OperationalRunbookRepository runbooks = mock(OperationalRunbookRepository.class);
    private final ObjectMapper mapper = new ObjectMapper();

    private final UUID projectId = UUID.randomUUID();
    private final OperationalEnvironmentEntity production = new OperationalEnvironmentEntity(
            null, "production", "Production", OperationalEnvironmentEntity.Kind.PRODUCTION);

    private RepositoryRunbookDiscovery service(StubGitHub client) {
        return new RepositoryRunbookDiscovery(projects, projectService, registry, client, mapper);
    }

    private void stubProject() {
        ProjectEntity project = new ProjectEntity("Richmod", "richmod", ProjectSourceType.GIT,
                null, "https://github.com/raufimusaddiq/richmod", "main");
        when(projects.findById(projectId)).thenReturn(Optional.of(project));
        when(projectService.githubToken(projectId)).thenReturn("");
        when(registry.environments(projectId)).thenReturn(List.of(production));
    }

    @Test
    void repositoryManifestIsUsedWhenTheRepositoryDeclaresOne() {
        stubProject();
        ObjectNode manifest = manifest();
        StubGitHub client = new StubGitHub(SHA, manifest);

        RepositoryRunbookDiscovery.Plan plan = service(client).plan(projectId, "production");

        assertThat(plan.source()).isEqualTo(RepositoryRunbookDiscovery.Source.REPOSITORY_MANIFEST);
        assertThat(plan.commitSha()).isEqualTo(SHA);
        assertThat(plan.action()).isEqualTo("PRODUCTION_DEPLOY");
        assertThat(plan.approvalExpectation()).contains("REQUIRE_HUMAN");
        assertThat(plan.steps()).extracting(OperationalRegistryService.StepSpec::type)
                .containsExactly(OperationalRegistryService.StepType.GITHUB_WORKFLOW,
                        OperationalRegistryService.StepType.SERVICE_CHECK);
    }

    @Test
    void syncRecordsTheExactCommitAReusableRunbookWasDiscoveredFrom() {
        stubProject();
        when(registry.environments(projectId)).thenReturn(List.of(production));
        when(registry.runbookRepository()).thenReturn(runbooks);
        when(runbooks.findByProjectIdAndKey(any(), anyString())).thenReturn(Optional.empty());
        OperationalRunbookEntity created = new OperationalRunbookEntity(projectId, UUID.randomUUID(), "production-deploy",
                "production-deploy", "PRODUCTION_DEPLOY", "discovered", "[]");
        when(registry.createRunbook(any(), any(), anyString(), anyString(), anyString(), anyString(), any()))
                .thenReturn(created);
        when(runbooks.save(any())).thenAnswer(invocation -> invocation.getArgument(0));

        RepositoryRunbookDiscovery.Plan plan = service(new StubGitHub(SHA, manifest())).sync(projectId, "production");

        assertThat(plan.registered()).isTrue();
        assertThat(created.getSource()).isEqualTo("REPOSITORY_MANIFEST");
        assertThat(created.getSourceRepository()).isEqualTo("raufimusaddiq/richmod");
        assertThat(created.getSourceCommit()).isEqualTo(SHA);
        assertThat(created.getSourcePath()).isEqualTo(RepositoryRunbookDiscovery.MANIFEST_PATH);
    }

    @Test
    void missingManifestFallsBackToHumanGatedDeployment() {
        stubProject();
        RepositoryRunbookDiscovery.Plan plan = service(new StubGitHub(SHA, null)).plan(projectId, "production");

        assertThat(plan.source()).isEqualTo(RepositoryRunbookDiscovery.Source.HUMAN_GATED_FALLBACK);
        assertThat(plan.runbookKey()).isEqualTo(RepositoryRunbookDiscovery.FALLBACK_KEY);
        assertThat(plan.action()).isEqualTo("PRODUCTION_DEPLOY");
        assertThat(plan.registered()).isFalse();
        assertThat(plan.steps()).isEmpty();
        assertThat(plan.fallbackReason()).contains(RepositoryRunbookDiscovery.MANIFEST_PATH);
    }

    @Test
    void repositoryManifestMayNotDeclareCommandSteps() {
        stubProject();
        ObjectNode manifest = manifest();
        ArrayNode steps = (ArrayNode) manifest.get("steps");
        ObjectNode command = steps.addObject();
        command.put("key", "shell");
        command.put("name", "Run shell");
        command.put("type", "COMMAND");
        command.putObject("config").putArray("argv").add("sh").add("-c").add("rm -rf /");

        RepositoryRunbookDiscovery.Plan plan = service(new StubGitHub(SHA, manifest)).plan(projectId, "production");

        assertThat(plan.source()).isEqualTo(RepositoryRunbookDiscovery.Source.HUMAN_GATED_FALLBACK);
        assertThat(plan.fallbackReason()).contains("COMMAND");
    }

    @Test
    void invalidManifestFailsClosedToHumanGatedDeployment() {
        stubProject();
        ObjectNode manifest = manifest();
        ((ObjectNode) manifest.get("steps").get(0)).put("type", "RUN_ANYTHING");

        RepositoryRunbookDiscovery.Plan plan = service(new StubGitHub(SHA, manifest)).plan(projectId, "production");

        assertThat(plan.source()).isEqualTo(RepositoryRunbookDiscovery.Source.HUMAN_GATED_FALLBACK);
        assertThat(plan.fallbackReason()).contains("unsupported step type");
    }

    @Test
    void repositoryManifestCannotChangeTheDeploymentAction() {
        stubProject();
        ObjectNode manifest = manifest().put("action", "DELETE_DATA");

        RepositoryRunbookDiscovery.Plan plan = service(new StubGitHub(SHA, manifest)).plan(projectId, "production");

        assertThat(plan.source()).isEqualTo(RepositoryRunbookDiscovery.Source.HUMAN_GATED_FALLBACK);
        assertThat(plan.fallbackReason()).contains("PRODUCTION_DEPLOY");
    }

    @Test
    void repositoryManifestCannotPersistSecretWorkflowInputs() {
        stubProject();
        ObjectNode manifest = manifest();
        ((ObjectNode) manifest.get("steps").get(0)).withObject("config").putObject("inputs").put("token", "secret-ref");

        RepositoryRunbookDiscovery.Plan plan = service(new StubGitHub(SHA, manifest)).plan(projectId, "production");

        assertThat(plan.source()).isEqualTo(RepositoryRunbookDiscovery.Source.HUMAN_GATED_FALLBACK);
        assertThat(plan.fallbackReason()).contains("secret workflow input");
    }

    private ObjectNode manifest() {
        ObjectNode manifest = mapper.createObjectNode();
        manifest.put("version", 1);
        manifest.put("action", "PRODUCTION_DEPLOY");
        manifest.put("environment", "production");
        ArrayNode steps = manifest.putArray("steps");
        ObjectNode deploy = steps.addObject();
        deploy.put("key", "deploy");
        deploy.put("name", "Deploy production");
        deploy.put("type", "GITHUB_WORKFLOW");
        ObjectNode deployConfig = deploy.putObject("config");
        deployConfig.put("mode", "DISPATCH");
        deployConfig.put("repository", "raufimusaddiq/richmod");
        deployConfig.put("workflow", "deploy-production.yml");
        deployConfig.put("ref", "main");
        ObjectNode health = steps.addObject();
        health.put("key", "health");
        health.put("name", "Verify health");
        health.put("type", "SERVICE_CHECK");
        ObjectNode healthConfig = health.putObject("config");
        healthConfig.put("service", "web");
        healthConfig.put("probe", "health");
        return manifest;
    }

    /** Stubs the GitHub reads so discovery logic is tested without network access. */
    private static final class StubGitHub extends RepositoryRunbookDiscovery.GitHubManifestClient {
        private final String sha;
        private final JsonNode manifest;

        StubGitHub(String sha, JsonNode manifest) {
            super(null);
            this.sha = sha;
            this.manifest = manifest;
        }

        @Override
        String resolveCommitSha(String repository, String ref, String token) { return sha; }

        @Override
        JsonNode fetchManifest(String repository, String commitSha, String token) { return manifest; }
    }
}
