package com.agenticform.operation;

import com.agenticform.AgenticformApplication;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectRepository;
import com.agenticform.project.ProjectSourceType;
import com.agenticform.task.TaskDeliveryStage;
import com.agenticform.task.TaskDeliverable;
import com.agenticform.task.TaskDispatchService;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.ConfigurableApplicationContext;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * End-to-end delivery journey on a disposable PostgreSQL: a root application task
 * is bound to a deployment runbook that asserts the exact revision and probes a
 * local health endpoint, then the task is verified DELIVERED through the real
 * executor and service layer. Never point this at a non-disposable database.
 */
public final class DeliveryJourneyTestSupport {
    private final String url;
    private final String user;
    private final String password;

    public DeliveryJourneyTestSupport(String url, String user, String password) {
        this.url = url;
        this.user = user;
        this.password = password;
    }

    public void run() throws Exception {
        SpringApplication application = new SpringApplication(AgenticformApplication.class);
        application.setWebApplicationType(WebApplicationType.SERVLET);
        Path workspace = Files.createTempDirectory("agenticform-delivery-journey");
        initializeRepository(workspace);
        runJourney(application, workspace);
    }

    private void initializeRepository(Path workspace) throws Exception {
        Files.writeString(workspace.resolve("README.md"), "delivery journey fixture\n");
        for (List<String> argv : List.of(
                List.of("git", "init", "-q", "-b", "main"),
                List.of("git", "-C", workspace.toString(), "-c", "user.email=t@example.com", "-c", "user.name=T",
                        "add", "README.md"),
                List.of("git", "-C", workspace.toString(), "-c", "user.email=t@example.com", "-c", "user.name=T",
                        "commit", "-q", "-m", "fixture"))) {
            Process process = new ProcessBuilder(argv).directory(workspace.toFile()).redirectErrorStream(true).start();
            process.getInputStream().readAllBytes();
            assertEquals(0, process.waitFor(), "fixture git command failed: " + argv);
        }
    }

    private String headRevision(Path workspace) throws Exception {
        Process process = new ProcessBuilder("git", "-C", workspace.toString(), "rev-parse", "HEAD")
                .redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).trim();
        assertEquals(0, process.waitFor(), "git rev-parse failed: " + output);
        return output;
    }

    private void runJourney(SpringApplication application, Path workspace) throws Exception {
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        try {
            server.createContext("/health", exchange -> {
                byte[] body = "ok".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
            });
            server.start();
            try (ConfigurableApplicationContext context = application.run(
                    "--spring.datasource.url=" + url,
                    "--spring.datasource.username=" + user,
                    "--spring.datasource.password=" + password,
                    "--server.port=0",
                    "--agenticform.public-url=http://localhost:8080",
                    "--agenticform.ui.origin=http://localhost:5173",
                    "--agenticform.security.admin-token=0123456789abcdef0123456789abcdef",
                    "--agenticform.project-roots[0]=" + workspace,
                    "--agenticform.scheduler.dispatch-delay-ms=3600000",
                    "--agenticform.scheduler.reconcile-delay-ms=3600000",
                    "--agenticform.node.recovery-delay-ms=3600000",
                    "--agenticform.node.health-delay-ms=3600000")) {
                execute(context, workspace, server.getAddress().getPort());
            } finally {
                server.stop(0);
            }
        } catch (java.io.IOException error) {
            throw error;
        }
    }

    private void execute(ConfigurableApplicationContext context, Path workspace, int healthPort) throws Exception {
        ObjectMapper mapper = context.getBean(ObjectMapper.class);
        ProjectRepository projects = context.getBean(ProjectRepository.class);
        TaskRepository tasks = context.getBean(TaskRepository.class);
        TaskDispatchService dispatch = context.getBean(TaskDispatchService.class);
        OperationalRegistryService registry = context.getBean(OperationalRegistryService.class);
        OperationRunService runs = context.getBean(OperationRunService.class);
        RunbookExecutor executor = context.getBean(RunbookExecutor.class);
        com.agenticform.agent.AgentRepository agents = context.getBean(com.agenticform.agent.AgentRepository.class);

        ProjectEntity project = projects.save(new ProjectEntity("journey", "journey-" + UUID.randomUUID(),
                ProjectSourceType.LOCAL_PATH, workspace.toString(), null, "main"));
        var agent = new com.agenticform.agent.AgentEntity(project.getId(), "Journey Agent",
                "fixture", null, com.agenticform.workspace.WorkspaceMode.SHARED_PROJECT,
                workspace.toString(), workspace.toString(), "main",
                com.agenticform.agent.AgentQueueMode.AUTO, com.agenticform.agent.HumanControlMode.ON_THE_LOOP);
        agent.setRuntimeType(com.agenticform.runtime.RuntimeType.CODEX);
        agent = agents.save(agent);
        UUID agentId = agent.getId();

        TaskEntity root = tasks.save(new TaskEntity(project.getId(), agentId, "ship feature", "implement the feature", 0));
        root.configureDelivery(TaskDeliverable.IMPLEMENTATION, true, false, true, "staging");
        root.setStatus(com.agenticform.task.TaskStatus.RUNNING);
        tasks.save(root);
        // A root application task is bound to the deployment runbook through the
        // same resolution path used by request_operation.
        assertEquals(root.getId(), dispatch.resolveDeliverableRoot(project.getId(), root.getId(), null));

        OperationalEnvironmentEntity environment = registry.createEnvironment(project.getId(), "staging",
                "Staging", OperationalEnvironmentEntity.Kind.STAGING);
        OperationalRunbookEntity runbook = registry.createRunbook(project.getId(), environment.getId(), "deploy",
                "Deploy staging", "DEPLOY_STAGING", "Deploy verified artifact to staging", List.of(
                        new OperationalRegistryService.StepSpec("revision", "Assert revision",
                                OperationalRegistryService.StepType.ASSERT_GIT_SHA,
                                mapper.createObjectNode().put("expected", "${param:expectedSha}"), 30),
                        new OperationalRegistryService.StepSpec("health", "Probe health",
                                OperationalRegistryService.StepType.HTTP_CHECK,
                                mapper.createObjectNode().put("url", "http://127.0.0.1:" + healthPort + "/health"), 30)));

        String revision = headRevision(workspace);
        Map<String, String> parameters = Map.of("expectedSha", revision);

        // Staging is not production, so the seeded REQUIRE_HUMAN rule does not match.
        // The delivery gate still requires runbook evidence; policy gating for the
        // production path is covered by DeterministicPolicyEngineTest and V1 seeds.
        OperationRunEntity run = runs.start(runbook.getId(), new OperationRunService.StartRequest(
                agentId, root.getId(), "test", parameters));
        assertEquals(OperationRunEntity.Status.QUEUED, run.getStatus(),
                "staging deployment with seeded policy should queue without extra approval");
        executor.execute(run.getId());

        OperationRunEntity completed = runs.detail(run.getId()).run();
        assertEquals(OperationRunEntity.Status.SUCCEEDED, completed.getStatus(),
                () -> "run failed: " + completed.getLastError());

        TaskEntity delivered = tasks.findById(root.getId()).orElseThrow();
        assertEquals(TaskDeliveryStage.DELIVERED, delivered.getDeliveryStage());
        assertTrue(delivered.hasVerifiedDelivery());
        assertEquals("staging", delivered.getDeliveryEnvironment());
        assertEquals(revision, delivered.getDeliveryRevision());
        assertEquals(run.getId(), delivered.getDeliveryOperationRunId());
        assertNotNull(delivered.getDeliveryVerifiedAt());
        assertTrue(delivered.getDeliveryHealthEvidence().contains("health"));

        // A task without the exact revision cannot be marked delivered.
        TaskEntity unrevisioned = tasks.save(new TaskEntity(project.getId(), agentId, "no revision", "implement", 0));
        unrevisioned.configureDelivery(TaskDeliverable.IMPLEMENTATION, true, false, true, "staging");
        unrevisioned.setStatus(com.agenticform.task.TaskStatus.RUNNING);
        tasks.save(unrevisioned);
        OperationRunEntity blind = runs.start(runbook.getId(), new OperationRunService.StartRequest(
                agentId, unrevisioned.getId(), "test", Map.of()));
        assertEquals(OperationRunEntity.Status.QUEUED, blind.getStatus());
        executor.execute(blind.getId());
        assertEquals(TaskDeliveryStage.NOT_STARTED,
                tasks.findById(unrevisioned.getId()).orElseThrow().getDeliveryStage(),
                "a run without an exact revision must not mark delivery");

        // The root still cannot self-complete on prose while delivery is pending.
        assertThrows(TaskDispatchService.ReportRejectedException.class,
                () -> dispatch.report(agentId, unrevisioned.getId(), 0, "done"));
    }
}
