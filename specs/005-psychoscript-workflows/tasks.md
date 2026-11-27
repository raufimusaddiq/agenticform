# Tasks: Psychoscript Durable Workflows & Script Runtime

- [x] Create `@agenticform/script` package (`packages/script`) over `psychoscript@^0.3.0` and `ScriptRunsPort`.
- [x] Add workflow wire types and error codes to `packages/protocol`.
- [x] Add hub configuration (`AGENTICFORM_WORKFLOW_*`), error mappings, and SQLite schema migration v8 (`workflows` table).
- [x] Implement `WorkflowManager` in `packages/hub/src/workflows.ts` with auto-parking, event/sweep wakeup, crash recovery, and `POST/GET /v1/workflows`.
- [x] Add workflow methods to `HubClient` (`packages/client`), `af workflow` / `af script` (`packages/cli`), and `*_workflow` tools (`packages/mcp`).
- [x] Document architecture, configuration variables, CLI, and MCP tools in `README.md` and `docs/architecture.md`.
- [x] Add contract, confinement, limit, auth, cancellation, and cross-restart durability tests across `script`, `hub`, `client`, `cli`, and `mcp`.
