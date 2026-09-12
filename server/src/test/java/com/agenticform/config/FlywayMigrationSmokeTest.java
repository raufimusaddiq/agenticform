package com.agenticform.config;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FlywayMigrationSmokeTest {
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
        Flyway baseline = Flyway.configure()
                .dataSource(url, user, password)
                .locations("classpath:db/migration")
                .target("14")
                .load();
        var first = baseline.migrate();
        assertTrue(first.success, "pre-runtime Flyway migration should succeed");
        assertTrue(first.migrationsExecuted > 0, "expected pre-runtime migrations to execute");

        UUID projectId = UUID.randomUUID();
        UUID agentId = UUID.randomUUID();
        Instant now = Instant.now();
        try (Connection connection = DriverManager.getConnection(url, user, password);
             PreparedStatement project = connection.prepareStatement("""
                     INSERT INTO projects (id, name, slug, root_directory, default_branch, enabled, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, TRUE, ?, ?)
                     """);
             PreparedStatement agent = connection.prepareStatement("""
                     INSERT INTO agents (id, project_id, name, responsibility, codex_thread_id, workspace_mode,
                         source_directory, working_directory, branch, status, queue_mode, active_task_id,
                         active_turn_id, created_at, updated_at, human_control_mode, agent_role, system_managed,
                         execution_node_id, runtime_generation, capability_profile)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, FALSE, NULL, 0, ?)
                     """)) {
            project.setObject(1, projectId);
            project.setString(2, "migration smoke");
            project.setString(3, "migration-smoke-" + projectId);
            project.setString(4, "/tmp/migration-smoke-" + projectId);
            project.setString(5, "main");
            project.setTimestamp(6, Timestamp.from(now));
            project.setTimestamp(7, Timestamp.from(now));
            project.executeUpdate();

            agent.setObject(1, agentId);
            agent.setObject(2, projectId);
            agent.setString(3, "legacy agent");
            agent.setString(4, "migration test");
            agent.setString(5, "legacy-codex-thread");
            agent.setString(6, "ISOLATED_WORKTREE");
            agent.setString(7, "/tmp/source");
            agent.setString(8, "/tmp/work");
            agent.setString(9, "agent/legacy");
            agent.setString(10, "IDLE");
            agent.setString(11, "AUTO");
            agent.setTimestamp(12, Timestamp.from(now));
            agent.setTimestamp(13, Timestamp.from(now));
            agent.setString(14, "IN_THE_LOOP");
            agent.setString(15, "GENERAL");
            agent.setString(16, "IMPLEMENTER");
            agent.executeUpdate();
        }

        var migrated = configuration.migrate();
        assertTrue(migrated.success, "runtime migrations should succeed");
        try (Connection connection = DriverManager.getConnection(url, user, password);
             PreparedStatement query = connection.prepareStatement(
                     "SELECT runtime_type, runtime_session_id FROM agents WHERE id = ?")) {
            query.setObject(1, agentId);
            try (var rows = query.executeQuery()) {
                assertTrue(rows.next(), "legacy agent should survive runtime migration");
                assertEquals("CODEX", rows.getString("runtime_type"));
                assertEquals("legacy-codex-thread", rows.getString("runtime_session_id"));
            }
        }

        var second = configuration.migrate();
        assertTrue(second.success, "second Flyway migration should remain successful");
        assertEquals(0, second.migrationsExecuted, "migrations must be stable on an already-current schema");
    }
}
