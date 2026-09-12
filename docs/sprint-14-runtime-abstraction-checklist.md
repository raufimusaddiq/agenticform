# Sprint 14 — Runtime Abstraction Checklist

Scope: make Codex the first runtime adapter. Preserve existing behavior, data, recovery, and security.

## Contract and domain

- [x] Define initial runtime-neutral type, session, and dispatch models.
- [x] Add an internal `AgentRuntime` SPI for start, dispatch, resume, interrupt, and runtime-specific start parameters.
- [x] Remove `CodexGateway` injection from core project/task/message/operation orchestration; retain Codex-only tool/transport code at the adapter boundary.
- [x] Keep local runtime session IDs behind `RuntimeSession`; persistence exposes neutral `runtimeSessionId`.

## Codex adapter

- [x] Add `CodexAgentRuntime` adapter over the existing App Server gateway.
- [x] Route local agent spawn, interrupt, and task dispatch through `AgentRuntime`.
- [x] Route local queue reconciliation and lifecycle interruption through `AgentRuntime`.
- [x] Route local message, operation-event, and incident delivery through `AgentRuntime`.
- [x] Preserve dynamic Agenticform tools and fail-closed approval behavior with namespace and protected-operation tests.
- [x] Preserve exact `(node, generation, runtimeType, runtimeSessionId)` fencing and durable remote command recovery.
- [x] Add runtime-port contract coverage proving task orchestration does not require `CodexGateway`.

## Persistence and compatibility

- [x] Add runtime type/session fields without destructive reset.
- [x] Rename provider-specific task, message, operation-event, and incident execution fields to neutral names.
- [x] Persist runtime type and opaque `runtimeSessionId` directly; no legacy Codex identity column.
- [x] Keep Flyway numbering ordered after the current operational-intelligence migration.
- [x] Verify migrated-agent compatibility and idempotent V14→V19 migration.

## Node scheduling

- [x] Advertise structured runtime inventory while retaining the legacy Codex capability alias.
- [x] Persist runtime type on node observations and include it in node heartbeats/commands.
- [x] Include runtime type in remote start, dispatch, delivery, recovery, and stop payloads.
- [x] Reject unsupported runtime types at the node command boundary; runtime type is required.
- [x] Use runtime-specific placement/recovery requirements without legacy alias parsing.
- [x] Validate runtime requirements during placement and command dispatch.
- [x] Preserve node identity, capability sandbox, and tenant/security checks through existing node security tests.
- [x] Document the inventory payload and compatibility behavior.

## Verification and exit gate

- [x] Add focused server tests for SPI contracts, scheduling, events, approvals, lifecycle, and recovery.
- [x] Run `cd server && mvn test`.
- [x] Run `cd web && npm run build`.
- [x] Run `cd node && go test ./...`.
- [ ] Run exact-head CI checks.
- [ ] Confirm a second runtime implementation can be added without changing orchestration core; currently only the Codex adapter is implemented.
- [x] Update architecture and operations documentation.
