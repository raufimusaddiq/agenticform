# Repository Guidelines

## Project Structure & Module Organization

- `packages/` is the codebase: a Bun/TypeScript workspace. `packages/runtime/` holds the local run API, ACP driver and conformance suite; `packages/protocol/`, `packages/node/`, `packages/hub/`, `packages/client/`, `packages/cli/` and `packages/mcp/` are the layers above it.
- `specs/` holds Spec Kit feature specs. `.specify/memory/constitution.md` holds project principles and overrides other guidance.
- `docs/` holds current documentation.

## Workflow

Non-trivial work follows Spec Kit: specify, plan, tasks, implement. Read the constitution first. Agenticform owns running work, not planning it, so keep task and project logic out of core packages.

## Build, Test, and Development Commands

```bash
bun install
bun run typecheck
bun test packages
AGENTICFORM_CONFORMANCE_HARNESS=codex bun test packages # opt-in; may use paid inference
AGENTICFORM_REAL_HARNESS=1 bun test packages # opt-in; spawns installed harness CLIs (claude, opencode)
```

## Coding Style & Naming Conventions

TypeScript uses two spaces, double quotes and no semicolons. Use `PascalCase` for types and components, `camelCase` for methods and variables.

## Testing Guidelines

Test contracts and failure boundaries, using real child processes where process behaviour matters. Conformance cases must work for every harness. Exercise security, policy, and durable-workflow failure paths; do not weaken fail-closed behavior merely to simplify a test.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects seen in history: `feat:`, `fix:`, `test:`, `security:`, `docs:`, `style:`, or `ci:`. Keep commits scoped. PRs need a clear behavior summary, validation commands/results, linked issue when applicable, migration/configuration notes, and UI screenshots for visible changes.

## Security & Configuration

Never commit tokens, webhook secrets, private keys, or local state. Failure stays closed: deny unanswered permissions, treat unknown capabilities as absent, and never replay ambiguous effects. Keep harness credentials and stderr out of events. Remote work must preserve outbound-only nodes, fencing, nonces and idempotency. Document new environment variables in `README.md`.
