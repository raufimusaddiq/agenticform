# Sprint 14 — Runtime Abstraction Checklist

Scope: make Codex the first runtime adapter. Preserve existing behavior, data, recovery, and security.

## Contract and domain

- [ ] Define runtime-neutral IDs, types, capabilities, session, turn, input, and snapshot models.
- [ ] Add an internal `AgentRuntime` SPI for start, submit, steer, interrupt, inspect, and stop.
- [ ] Remove Codex protocol types from core project/task/message/policy/operation paths.
- [ ] Keep runtime session IDs opaque to core orchestration.

## Codex adapter

- [ ] Move App Server transport, thread/turn mapping, event translation, approvals, queueing, and reconnect logic behind `CodexAgentRuntime`.
- [ ] Preserve dynamic Agenticform tools and fail-closed approval behavior.
- [ ] Preserve runtime-generation fencing and durable remote command recovery.
- [ ] Add fake-runtime contract coverage proving orchestration does not require Codex.

## Persistence and compatibility

- [ ] Add runtime type/profile/session fields without destructive reset.
- [ ] Migrate existing `codexThreadId` values to `runtimeType=CODEX` and opaque `runtimeSessionId`.
- [ ] Keep Flyway numbering ordered after the current operational-intelligence migration.
- [ ] Verify restart, reconciliation, node loss, and queued-task behavior on migrated data.

## Node scheduling

- [ ] Replace hard-coded Codex availability with structured runtime inventory.
- [ ] Validate runtime requirements during placement and command dispatch.
- [ ] Preserve node identity, capability sandbox, and tenant/security checks.
- [ ] Document the inventory payload and compatibility behavior.

## Verification and exit gate

- [ ] Add focused server tests for SPI contracts, migration, scheduling, events, approvals, and recovery.
- [ ] Run `cd server && mvn test`.
- [ ] Run `cd web && npm run build` and `cd node && go test ./...`.
- [ ] Run Flyway/database smoke validation and exact-head CI checks.
- [ ] Confirm a second runtime can be added without an `Agent`/`Task` schema redesign.
- [ ] Update architecture and operations documentation; mark this checklist complete only after all exit criteria pass.
