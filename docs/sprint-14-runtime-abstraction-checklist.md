# Sprint 14 — Runtime Abstraction Checklist

Scope: make Codex the first runtime adapter. Preserve existing behavior, data, recovery, and security.

## Contract and domain

- [x] Define initial runtime-neutral type, session, and dispatch models.
- [x] Add an internal `AgentRuntime` SPI for start, dispatch, resume, and interrupt.
- [x] Remove `CodexGateway` injection from core project/task/message/operation orchestration; retain Codex-only tool/transport code at the adapter boundary.
- [x] Keep local runtime session IDs behind `RuntimeSession`; persistence exposes neutral `runtimeSessionId`.

## Codex adapter

- [x] Add `CodexAgentRuntime` adapter over the existing App Server gateway.
- [x] Route local agent spawn, interrupt, and task dispatch through `AgentRuntime`.
- [x] Route local queue reconciliation and lifecycle interruption through `AgentRuntime`.
- [x] Route local message, operation-event, and incident delivery through `AgentRuntime`.
- [ ] Preserve dynamic Agenticform tools and fail-closed approval behavior.
- [ ] Preserve runtime-generation fencing and durable remote command recovery.
- [x] Add runtime-port contract coverage proving task orchestration does not require `CodexGateway`.

## Persistence and compatibility

- [x] Add runtime type/session fields without destructive reset.
- [x] Migrate existing `codexThreadId` values to `runtimeType=CODEX` and opaque `runtimeSessionId`.
- [x] Keep Flyway numbering ordered after the current operational-intelligence migration.
- [ ] Verify restart, reconciliation, node loss, and queued-task behavior on migrated data.

## Node scheduling

- [x] Advertise structured runtime inventory while retaining the legacy Codex capability alias.
- [x] Persist runtime type on node observations and include it in node heartbeats/commands.
- [x] Include runtime type in remote start, dispatch, delivery, recovery, and stop payloads.
- [x] Reject unsupported runtime types at the node command boundary; legacy missing type defaults to `CODEX`.
- [x] Replace production placement/recovery Codex requirements with `runtime:CODEX`; retain legacy alias parsing.
- [ ] Validate runtime requirements during placement and command dispatch.
- [ ] Preserve node identity, capability sandbox, and tenant/security checks.
- [ ] Document the inventory payload and compatibility behavior.
- [x] Document the inventory payload and compatibility behavior.

## Verification and exit gate

- [ ] Add focused server tests for SPI contracts, migration, scheduling, events, approvals, and recovery.
- [x] Run `cd server && mvn test` (Docker Maven image; passed September 12, 2026).
- [x] Run `cd web && npm run build` (Docker Node image with `npm install --package-lock=false`; passed September 12, 2026).
- [x] Run `cd node && go test ./...` (Docker Go image; passed September 12, 2026).
- [x] Run Flyway/database smoke validation and exact-head CI checks (PR #16 CI passed September 12, 2026).
- [ ] Confirm a second runtime can be added without an `Agent`/`Task` schema redesign.
- [ ] Update architecture and operations documentation; mark this checklist complete only after all exit criteria pass.
