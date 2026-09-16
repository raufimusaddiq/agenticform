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
