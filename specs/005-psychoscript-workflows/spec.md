# Feature Specification: Psychoscript Durable Workflows & Script Runtime

**Feature Branch**: `feat/005-psychoscript-workflows`

**Created**: 2026-11-27

**Status**: Implemented

**Input**: Add confined, resumable JavaScript workflows ("code mode") using `anomalyco/psychoscript` so callers and agents can compose multiple runs safely and survive process or hub restarts.

## Scope

This feature adds two complementary layers on top of Agenticform's run execution fabric:

1. **Caller-side library (`@agenticform/script` in `packages/script`)** — wraps `psychoscript` over a minimal `ScriptRunsPort` interface (structurally satisfied by `HubClient`) so any application, CLI (`af script`), or external orchestrator can execute confined JavaScript scripts that invoke `af.run(...)` and suspend/resume to bytes locally with zero hub modifications.
2. **Hub-hosted durable workflows (`packages/hub` + `packages/client` + `packages/cli` + `packages/mcp`)** — stores and drives workflows in SQLite (`workflows` table, schema v8) via `/v1/workflows`, automatically parking active scripts to snapshot bytes while awaiting child runs and resuming them when child runs finish, including across hub restarts.

### Constitution Principle I Exception

Agenticform's Constitution Principle I (*Execution, Not Orchestration*) states that callers own planning and task graphs while Agenticform owns runs. Hub-hosted durable workflows (`/v1/workflows`) are an **explicit, opt-in exception** scoped strictly to running caller-supplied, confined Psychoscript programs:

- **Principle II (Library First) is preserved:** All VM confinement, host-tool bindings, and snapshot serialization live in `@agenticform/script` (`packages/script`), which works standalone over `ScriptRunsPort` / `HubClient` without needing hub workflow endpoints.
- **Core isolation is preserved:** `packages/runtime` and `packages/node` are untouched; wire `PROTOCOL_VERSION` stays `1`.
- **No task/board state is introduced:** The hub does not interpret tasks, roles, or prompts—it executes an opaque, confined script and stores its durable snapshot bytes.

Out of scope: modifying `packages/runtime` or `packages/node`, granting scripts admin privileges (`answerPermission`, token issuance, node disable/revoke), or allowing ambient I/O (`fs`, `fetch`, `process`, timers, `eval`) inside scripts.

## User Scenarios & Testing

### User Story 1 - Caller-side confined code mode (`@agenticform/script` and `af script`)

A developer or calling agent wants to compose multiple runs (for example, fanning out reviews or chaining follow-up runs) in a single confined JavaScript program without spinning up a container or granting filesystem/network access.

**Acceptance Scenarios**:
1. **Given** a `ScriptRunsPort` (or `HubClient`), **When** a script calls `af.run(...)`, `af.listNodes()`, `af.startRun()`, `af.getRun()`, `af.listEvents()`, `af.listPermissions()`, or `af.cancelRun()`, **Then** it executes inside Psychoscript's VM and returns structured JSON.
2. **Given** untrusted script code attempting `process`, `fetch`, `Bun`, `eval`, `Function`, or `require("fs")`, **When** executed, **Then** access fails closed inside the VM.
3. **Given** a script suspended mid-flight while awaiting `af.run(...)`, **When** its snapshot bytes (`toBytes`) are resumed in a fresh runtime (`fromBytes`), **Then** the child run is NOT started a second time (deterministic idempotency key + `Host.durableFn`), and the script finishes with the exact result.

### User Story 2 - Hub-hosted durable workflows across restarts

A caller submits a workflow to `POST /v1/workflows` (HTTP, `af workflow`, or MCP `start_workflow`). While awaiting child runs on remote nodes, the hub suspends the VM to `snapshot_bytes` in SQLite and resumes it when child runs reach a terminal state—even after a hub restart.

**Acceptance Scenarios**:
1. **Given** a valid workflow submitted with `idempotencyKey`, **When** submitted again with the same payload, **Then** the existing workflow is returned; when submitted with a different payload, `409 idempotency_conflict` is returned.
2. **Given** a workflow with syntax errors or exceeding configured limits, **Then** submission fails closed with `400 script_invalid` or `422 workflow_limit_exceeded` before inserting a row.
3. **Given** a workflow waiting on an in-flight `af.run(...)` child run, **When** `workflowParkMs` elapses (or `hub.suspendWorkflows()` runs), **Then** the hub persists `status = 'suspended'` and `snapshot_bytes` in SQLite; when the hub restarts on the same database and the child run completes, the hub automatically resumes the workflow to `completed`.
4. **Given** a hard crash leaving `status = 'running'` with `snapshot_bytes IS NULL`, **When** the hub starts, **Then** the workflow is marked `failed` (`Interrupted`) rather than replayed ambiguously (Constitution IV).

### User Story 3 - Scoped auth, lineage depth, and cancellation

**Acceptance Scenarios**:
1. A scoped `runs` caller token can create, list, inspect, and cancel workflows; admin-only actions remain inaccessible inside scripts (`af` exposes no admin methods).
2. `parentRunId` enforces `parent_not_found` (`404`) and `depth_exceeded` (`422`) and propagates `parentRunId` to child runs started by the workflow.
3. Cancelling a running or suspended workflow cancels its active child runs and clears `snapshot_bytes`.
