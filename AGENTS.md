# Repository Guidelines

## Project Structure & Module Organization

- `server/` is the Java 21/Spring Boot control plane. Production code is under `server/src/main/java/com/agenticform/`, grouped by domain (`agent`, `policy`, `operation`, `node`); Flyway migrations live in `server/src/main/resources/db/migration/`.
- `server/src/test/java/` contains JUnit tests mirroring production packages.
- `web/` is the React 19 + TypeScript Vite UI. Keep views, API helpers, types, and CSS in `web/src/`.
- `node/` contains the Go execution-node daemon, currently centered on `cmd/agenticform-node/`.
- `docs/` holds architecture, operations, recovery, security, and UI specifications. Read the relevant document before changing cross-cutting behavior.

## Build, Test, and Development Commands

```bash
docker compose up -d postgres    # Start local PostgreSQL
cd server && mvn spring-boot:run # Run API on :8080
cd server && mvn test            # Run JUnit/Spring tests
cd web && npm install && npm run dev # Run Vite UI on :5173
cd web && npm run build          # Type-check and build UI
cd node && go test ./...         # Run Go daemon tests
```

Set `AGENTICFORM_ADMIN_TOKEN` to a random value of at least 32 characters before starting the backend. Local agents also require Codex App Server at the configured WebSocket endpoint.

## Coding Style & Naming Conventions

Follow existing style: four-space Java indentation; tabs/standard `gofmt` formatting in Go; two-space TypeScript/CSS indentation. Use `PascalCase` for Java/React types and components, `camelCase` for methods and variables, and `snake_case` Flyway files such as `V12__describe_change.sql`. Keep Spring code in its owning domain package. Run `gofmt` on changed Go files; `npm run build` is the UI type check.

## Testing Guidelines

Add focused JUnit 5 tests beside the matching server package; name test classes `*Test` and methods by expected behavior, e.g. `invalidBearerTokenDoesNotAuthenticate`. Add Go tests as `*_test.go`. Exercise security, policy, and durable-workflow failure paths; do not weaken fail-closed behavior merely to simplify a test.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects seen in history: `feat:`, `fix:`, `test:`, `security:`, `docs:`, `style:`, or `ci:`. Keep commits scoped. PRs need a clear behavior summary, validation commands/results, linked issue when applicable, migration/configuration notes, and UI screenshots for visible changes.

## Security & Configuration

Never commit tokens, webhook secrets, private keys, or local state. Preserve admin authentication, HTTPS requirements, immutable node-image checks, and outbound-only node design. Document new environment variables in `README.md`.
