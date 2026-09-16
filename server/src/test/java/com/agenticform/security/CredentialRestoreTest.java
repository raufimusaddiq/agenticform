package com.agenticform.security;

import com.agenticform.AgenticformApplication;
import com.agenticform.approval.HumanApprovalRepository;
import com.agenticform.agent.AgentRepository;
import com.agenticform.project.ProjectEntity;
import com.agenticform.project.ProjectRepository;
import com.agenticform.project.ProjectSourceType;
import com.agenticform.task.TaskEntity;
import com.agenticform.task.TaskRepository;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.ConfigurableApplicationContext;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Backup/restore verification against an isolated disposable database pair. The
 * same test class seeds a source database, and after an external pg_dump/restore
 * re-runs in verify mode against the restored database. Never point this at
 * production. Driven by MIGRATION_TEST_DATABASE_* plus RESTORE_TEST_MODE.
 */
class CredentialRestoreTest {
    private static final String ADMIN_TOKEN = "0123456789abcdef0123456789abcdef";
    private static final String ENCRYPTION_KEY = "restore-test-encryption-key-32-characters";
    static final String SLUG = "restore-fixture-project";
    static final String SECRET = "ghp_restore_fixture_do_not_log";

    @Test
    void seedAndVerifyEncryptedCredentialsAcrossRestore() {
        String url = System.getenv("MIGRATION_TEST_DATABASE_URL");
        String mode = System.getenv("RESTORE_TEST_MODE");
        Assumptions.assumeTrue(url != null && !url.isBlank() && mode != null && !mode.isBlank(),
                "restore test requires MIGRATION_TEST_DATABASE_URL and RESTORE_TEST_MODE");
        try (ConfigurableApplicationContext context = start(url)) {
            if (mode.equals("seed")) seed(context);
            else if (mode.equals("verify")) verify(context);
            else fail("RESTORE_TEST_MODE must be seed or verify");
        }
    }

    private ConfigurableApplicationContext start(String url) {
        SpringApplication application = new SpringApplication(AgenticformApplication.class);
        application.setWebApplicationType(WebApplicationType.SERVLET);
        return application.run(
                "--spring.datasource.url=" + url,
                "--spring.datasource.username=" + System.getenv("MIGRATION_TEST_DATABASE_USER"),
                "--spring.datasource.password=" + System.getenv("MIGRATION_TEST_DATABASE_PASSWORD"),
                "--server.port=0",
                "--agenticform.public-url=http://localhost:8080",
                "--agenticform.ui.origin=http://localhost:5173",
                "--agenticform.security.admin-token=" + ADMIN_TOKEN,
                "--agenticform.security.secret-key=" + ENCRYPTION_KEY,
                "--agenticform.scheduler.dispatch-delay-ms=3600000",
                "--agenticform.scheduler.reconcile-delay-ms=3600000",
                "--agenticform.node.recovery-delay-ms=3600000",
                "--agenticform.node.health-delay-ms=3600000");
    }

    private void seed(ConfigurableApplicationContext context) {
        ProjectRepository projects = context.getBean(ProjectRepository.class);
        TaskRepository tasks = context.getBean(TaskRepository.class);
        AgentRepository agents = context.getBean(AgentRepository.class);
        SecretBox secrets = context.getBean(SecretBox.class);

        ProjectEntity project = new ProjectEntity("Restore Fixture", SLUG, ProjectSourceType.LOCAL_PATH,
                null, "https://github.com/acme/restore-fixture.git", "main");
        project.setGithubTokenCiphertext(secrets.encrypt(SECRET));
        project = projects.save(project);

        var agent = new com.agenticform.agent.AgentEntity(project.getId(), "Restore Agent", "fixture", null,
                com.agenticform.workspace.WorkspaceMode.SHARED_PROJECT, "/tmp/restore", "/tmp/restore", "main",
                com.agenticform.agent.AgentQueueMode.AUTO, com.agenticform.agent.HumanControlMode.ON_THE_LOOP);
        agent.setRuntimeType(com.agenticform.runtime.RuntimeType.CODEX);
        agent = agents.save(agent);

        TaskEntity task = new TaskEntity(project.getId(), agent.getId(), "restored task", "prompt", 0);
        task.setStatus(com.agenticform.task.TaskStatus.COMPLETED);
        task.setReport("restored report");
        tasks.save(task);

        assertTrue(context.getBean(HumanApprovalRepository.class).count() >= 0);
        assertNotNull(project.getId());
    }

    private void verify(ConfigurableApplicationContext context) {
        ProjectRepository projects = context.getBean(ProjectRepository.class);
        TaskRepository tasks = context.getBean(TaskRepository.class);
        SecretBox secrets = context.getBean(SecretBox.class);

        ProjectEntity restored = projects.findBySlug(SLUG).orElseThrow();
        assertTrue(restored.isGithubTokenConfigured(), "restored project must keep its encrypted credential");
        assertEquals(SECRET, secrets.decrypt(restored.getGithubTokenCiphertext()),
                "restored credential must decrypt with the documented separate key");

        var restoredTasks = tasks.findAllByProjectIdOrderByCreatedAtDesc(restored.getId());
        assertEquals(1, restoredTasks.size());
        assertEquals("restored report", restoredTasks.get(0).getReport());
        assertEquals(com.agenticform.task.TaskStatus.COMPLETED, restoredTasks.get(0).getStatus());
        assertTrue(context.getBean(com.agenticform.policy.PolicyRuleRepository.class)
                .findAllByEnabledTrue().size() >= 5, "seed policy rules must survive restore");
    }
}
