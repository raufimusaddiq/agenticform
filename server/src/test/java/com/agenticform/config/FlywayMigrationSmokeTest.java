package com.agenticform.config;

import com.agenticform.AgenticformApplication;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.ConfigurableApplicationContext;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FlywayMigrationSmokeTest {
    @Test
    void deliveryJourneyThroughRunbookVerifiesDeploymentOnRealDatabase() throws Exception {
        String url = System.getenv("MIGRATION_TEST_DATABASE_URL");
        if (url == null || url.isBlank()) return;
        new com.agenticform.operation.DeliveryJourneyTestSupport(url,
                System.getenv("MIGRATION_TEST_DATABASE_USER"),
                System.getenv("MIGRATION_TEST_DATABASE_PASSWORD")).run();
    }

    @Test
    void migrationsUpgradeADatabaseThatAlreadyContainsNonImplementationTasks() throws Exception {
        String url = System.getenv("MIGRATION_TEST_DATABASE_URL");
        String user = System.getenv("MIGRATION_TEST_DATABASE_USER");
        String password = System.getenv("MIGRATION_TEST_DATABASE_PASSWORD");
        Assumptions.assumeTrue(url != null && !url.isBlank(),
                "migration smoke test requires MIGRATION_TEST_DATABASE_URL");

        Flyway upToV8 = Flyway.configure()
                .dataSource(url, user, password)
                .locations("classpath:db/migration")
                .cleanDisabled(false)
                .target("8")
                .load();
        upToV8.clean();
        upToV8.migrate();

        // Reproduces the live-upgrade shape that an empty-database smoke test cannot:
        // pre-existing rows of kinds other than IMPLEMENTATION must not leave the new
        // deliverable columns NULL when they are made NOT NULL.
        try (Connection connection = DriverManager.getConnection(url, user, password)) {
            connection.setAutoCommit(true);
            var projectId = java.util.UUID.randomUUID();
            var agentId = java.util.UUID.randomUUID();
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO projects (id, name, slug, source_type, default_branch, enabled, created_at, updated_at)"
                            + " VALUES (?, 'Legacy', 'legacy-upgrade-fixture', 'LOCAL_PATH', 'main', TRUE, NOW(), NOW())")) {
                insert.setObject(1, projectId);
                insert.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO agents (id, project_id, name, responsibility, runtime_type, workspace_mode, status,"
                            + " queue_mode, human_control_mode, agent_role, system_managed, capability_profile,"
                            + " runtime_generation, created_at, updated_at)"
                            + " VALUES (?, ?, 'Legacy Agent', 'fixture', 'CODEX', 'ISOLATED_WORKTREE', 'IDLE',"
                            + " 'AUTO', 'ON_THE_LOOP', 'GENERAL', FALSE, 'IMPLEMENTER', 0, NOW(), NOW())")) {
                insert.setObject(1, agentId);
                insert.setObject(2, projectId);
                insert.executeUpdate();
            }
            for (String kind : java.util.List.of("REVIEW", "ARCHITECTURE", "ORCHESTRATION", "IMPLEMENTATION", "GENERAL")) {
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO tasks (id, project_id, assigned_agent_id, priority, created_at, updated_at,"
                                + " workflow_id, title, prompt, status, kind)"
                                + " VALUES (?, ?, ?, 0, NOW(), NOW(), ?, ?, 'fixture', 'COMPLETED', ?)")) {
                    insert.setObject(1, java.util.UUID.randomUUID());
                    insert.setObject(2, projectId);
                    insert.setObject(3, agentId);
                    insert.setObject(4, java.util.UUID.randomUUID());
                    insert.setObject(5, "Legacy " + kind + " task");
                    insert.setObject(6, kind);
                    insert.executeUpdate();
                }
            }
        }

        Flyway upgrade = Flyway.configure()
                .dataSource(url, user, password)
                .locations("classpath:db/migration")
                .cleanDisabled(false)
                .load();
        var result = upgrade.migrate();
        assertTrue(result.success, "upgrade over existing task rows must succeed");

        try (Connection connection = DriverManager.getConnection(url, user, password);
             PreparedStatement query = connection.prepareStatement(
                     "SELECT count(*) AS total, count(deliverable) AS deliverable, count(deployment_required) AS deployment"
                             + " FROM tasks")) {
            try (var rows = query.executeQuery()) {
                assertTrue(rows.next());
                assertEquals(5, rows.getInt("total"));
                assertEquals(5, rows.getInt("deliverable"), "every legacy task needs a deliverable");
                assertEquals(5, rows.getInt("deployment"), "every legacy task needs a deployment flag");
            }
        }
    }

    @Test
    void allMigrationsApplyCleanlyAndAreIdempotent() throws Exception {
        String url = System.getenv("MIGRATION_TEST_DATABASE_URL");
        String user = System.getenv("MIGRATION_TEST_DATABASE_USER");
        String password = System.getenv("MIGRATION_TEST_DATABASE_PASSWORD");
        Assumptions.assumeTrue(url != null && !url.isBlank(),
                "migration smoke test requires MIGRATION_TEST_DATABASE_URL");

        Flyway configuration = Flyway.configure()
                .dataSource(url, user, password)
                .locations("classpath:db/migration")
                .cleanDisabled(false)
                .load();

        configuration.clean();
        SpringApplication application = new SpringApplication(AgenticformApplication.class);
        application.setWebApplicationType(WebApplicationType.SERVLET);
        try (ConfigurableApplicationContext ignored = application.run(
                "--spring.datasource.url=" + url,
                "--spring.datasource.username=" + user,
                "--spring.datasource.password=" + password,
                "--server.port=0",
                "--agenticform.public-url=http://localhost:8080",
                "--agenticform.ui.origin=http://localhost:5173",
                "--agenticform.security.admin-token=0123456789abcdef0123456789abcdef")) {
            // Startup must run Flyway before Hibernate validates mapped tables.
        }
        try (Connection connection = DriverManager.getConnection(url, user, password);
             PreparedStatement query = connection.prepareStatement(
                     "SELECT column_default FROM information_schema.columns "
                             + "WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'runtime_type'")) {
            try (var rows = query.executeQuery()) {
                assertTrue(rows.next(), "agents.runtime_type should exist");
                assertNull(rows.getString("column_default"));
            }
        }

        var second = configuration.migrate();
        assertTrue(second.success, "second Flyway migration should remain successful");
        assertEquals(0, second.migrationsExecuted, "migrations must be stable on an already-current schema");
    }
}
