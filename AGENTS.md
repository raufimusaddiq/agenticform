# Repository Guidelines

## Project Structure & Module Organization

- `packages/` is the current codebase: a Bun/TypeScript workspace. `packages/runtime/` holds the local run API, ACP driver and conformance suite.
- `specs/` holds Spec Kit feature specs. `.specify/memory/constitution.md` holds project principles and overrides other guidance.
- `docs/` holds current documentation. `docs/legacy/` describes the old stack.
- `server/` (Java/Spring Boot), `web/` (React) and `node/` (Go) are the legacy stack. Treat them as a behaviour reference; do not add features there.

## Workflow

Non-trivial work follows Spec Kit: specify, plan, tasks, implement. Read the constitution first. Agenticform owns running work, not planning it, so keep task and project logic out of core packages.

## Build, Test, and Development Commands

```bash
bun install
bun run typecheck
bun test packages
AGENTICFORM_CONFORMANCE_HARNESS=codex bun test packages # opt-in; may use paid inference
```

Legacy stack:

```bash
docker compose -f docker-compose.dev.yml up -d --wait postgres
cd server && mvn test
cd web && npm run build
cd node && go test ./...
```

## Coding Style & Naming Conventions

TypeScript in `packages/` uses two spaces, double quotes and no semicolons. Legacy code keeps its style: four-space Java indentation; tabs/standard `gofmt` formatting in Go; two-space TypeScript/CSS indentation. Use `PascalCase` for Java/React types and components, `camelCase` for methods and variables, and `snake_case` Flyway files such as `V12__describe_change.sql`. Keep Spring code in its owning domain package. Run `gofmt` on changed Go files; `npm run build` is the UI type check.

## Testing Guidelines

Test contracts and failure boundaries, using real child processes where process behaviour matters. Conformance cases must work for every harness. For legacy code, add focused JUnit 5 tests beside the matching server package; name test classes `*Test` and methods by expected behavior, e.g. `invalidBearerTokenDoesNotAuthenticate`. Add Go tests as `*_test.go`. Exercise security, policy, and durable-workflow failure paths; do not weaken fail-closed behavior merely to simplify a test.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects seen in history: `feat:`, `fix:`, `test:`, `security:`, `docs:`, `style:`, or `ci:`. Keep commits scoped. PRs need a clear behavior summary, validation commands/results, linked issue when applicable, migration/configuration notes, and UI screenshots for visible changes.

## Security & Configuration

Never commit tokens, webhook secrets, private keys, or local state. Failure stays closed: deny unanswered permissions, treat unknown capabilities as absent, and never replay ambiguous effects. Keep harness credentials and stderr out of events. Remote work must preserve outbound-only nodes, fencing, nonces and idempotency. Document new environment variables in `README.md`.
