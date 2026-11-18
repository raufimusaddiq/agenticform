---

description: "Task list for Node and Hub"
---

# Tasks: Node and Hub

**Input**: Design documents from `/specs/002-node-hub/`

**Tests**: Required by FR-001..FR-037 and constitution VI. Each failure boundary
in `docs/node-hub-invariants.md` gets a test task.

**Prerequisite**: `specs/001-runtime-foundation` implemented. `docs/node-hub-invariants.md` read.

## Phase 1: Setup

- [x] T001 Add `packages/protocol`, `packages/hub` and `packages/node` to the workspace with package.json and tsconfig
- [x] T002 Add a `hub`/`node` CI job that runs typecheck and tests without credentials
- [x] T003 Document `AGENTICFORM_HUB_URL`, `AGENTICFORM_ADMIN_TOKEN`, `AGENTICFORM_STATE_DIR` and node interval overrides in README

## Phase 2: Foundation

- [x] T004 Define wire types (envelope, heartbeat, command, completion, error) in `packages/protocol/src/index.ts`
- [x] T005 Implement the canonical string and command fingerprint in `packages/protocol/src/canonical.ts`
- [x] T006 Add canonical-string and fingerprint vectors in `packages/protocol/test/canonical.test.ts`
- [x] T007 Add hub config with startup validation in `packages/hub/src/config.ts` (FR-015)
- [x] T008 Add the SQLite schema, migrations and WAL setup in `packages/hub/src/schema.ts` (unique constraints from research)
- [x] T009 Add node config with the non-local HTTPS rule in `packages/node/src/config.ts` (FR-002)
- [x] T010 Add Ed25519 identity generate/load with mode `0600` in `packages/node/src/identity.ts` (FR-012)

## Phase 3: User Story 1 - Enroll without a port (P1)

- [x] T011 [US1] Add `POST /v1/enroll` with token hashing and atomic consume in `packages/hub/src/enrollment.ts` (FR-011)
- [x] T012 [US1] Add operator routes for enrollment tokens, disable and revoke in `packages/hub/src/enrollment.ts` and `nodes.ts`
- [x] T013 [US1] Add the node enrollment call and identity persistence in `packages/node/bin/node.ts`
- [x] T014 [US1] Test: one enrollment succeeds; reuse, expiry and race are rejected with generic errors (FR-011, FR-013)
- [x] T015 [US1] Test: a node started against a non-local `http://` URL refuses to start (FR-002)
- [x] T016 [US1] Test: an enrolled node opens no listening socket and completes enrollment by outbound call only (FR-001)

## Phase 4: User Story 2 - Remote run (P1)

- [x] T017 [US2] Add bearer auth with constant-time compare in `packages/hub/src/server.ts` (FR-014)
- [x] T018 [US2] Add signature verification, Ed25519-only key decode and nonce insert in `packages/hub/src/signatures.ts` (FR-006, FR-007, FR-008, FR-009)
- [x] T019 [US2] Add nonce cleanup on a schedule in `packages/hub/src/nonces.ts` (FR-010)
- [x] T020 [US2] Add heartbeat handling, inventory and protocol version check in `packages/hub/src/nodes.ts` (FR-004, FR-005)
- [x] T021 [US2] Add placement eligibility filter and least-loaded pick in `packages/hub/src/placement.ts` (FR-016, FR-017)
- [x] T022 [US2] Add `POST /v1/runs`, `GET /v1/runs/{id}` and cancel in `packages/hub/src/runs.ts`, with hub-issued ids only (FR-016, FR-017, FR-018, FR-019, FR-020)
- [x] T023 [US2] Add enqueue, lease, renew and complete with guarded updates in `packages/hub/src/commands.ts` (FR-026, FR-027)
- [x] T024 [US2] Add event append, `seq` assignment and replay in `packages/hub/src/events.ts` (FR-020)
- [x] T025 [US2] Add SSE streaming with `Last-Event-ID` in `packages/hub/src/events.ts`
- [x] T026 [US2] Add the node signed client with timeout and backoff in `packages/node/src/client.ts`
- [x] T027 [US2] Add the heartbeat loop in `packages/node/src/heartbeat.ts` (FR-004)
- [x] T028 [US2] Add the command poller and lease renewal in `packages/node/src/poller.ts` (FR-004)
- [x] T029 [US2] Add `run.start`, `run.cancel` and `run.inspect` execution through `runtime` in `packages/node/src/executor.ts` (FR-019)
- [x] T030 [US2] Add event normalisation and batching in `packages/node/src/events.ts`
- [x] T031 [US2] Add the hub entry point serving one versioned API and the node daemon entry point (FR-003)
- [x] T032 [US2] Test: one fake node runs a prompt end to end with ordered events and one terminal event (SC-001)
- [x] T033 [US2] Test: no eligible node fails with `no_eligible_node` and queues nothing (FR-017)
- [x] T034 [US2] Test: missing required capability is skipped at placement and reported, not degraded (FR-016)
- [x] T035 [US2] Test: same idempotency key returns the same run; different payload is `409` (FR-026)

## Phase 5: User Story 3 - Fencing and replay (P1)

- [x] T036 [US3] Add generation stamping, lease-time cancellation and completion-time rejection (FR-022, FR-023)
- [x] T037 [US3] Add node-side envelope/payload generation check and monotonic state in `packages/node/src/state.ts` (FR-021, FR-024)
- [x] T038 [US3] Add protocol version refusal for enqueue and lease (FR-005)
- [x] T039 [US3] Test: advance generation before lease cancels the command (FR-023)
- [x] T040 [US3] Test: stale completion is refused with no state change (FR-023)
- [x] T041 [US3] Test: signed request replay is rejected; a bad signature does not burn the nonce (FR-007, FR-009)
- [x] T042 [US3] Test: timestamp outside skew and unknown node both return the same generic error (FR-013)
- [x] T043 [US3] Test: nonce at the expiry boundary is refused; cleanup deletes expired rows (FR-010)
- [x] T044 [US3] Test: node rejects a reused command id with a different fingerprint (FR-028)

## Phase 6: User Story 4 - Durable receipts (P2)

- [x] T045 [US4] Implement the atomic ledger with `STARTED` before effect in `packages/node/src/ledger.ts` (FR-029)
- [x] T046 [US4] Cache terminal results and serve them on re-lease (FR-030)
- [x] T047 [US4] Refuse ambiguous `STARTED` replay with a visible failure (FR-031)
- [x] T048 [US4] Bound ledger growth without touching `STARTED` (FR-032)
- [x] T049 [US4] Test: kill the node after `STARTED`, restart, re-deliver — no second effect (SC-005)
- [x] T050 [US4] Test: lost completion then re-lease returns the cached result (FR-030)
- [x] T051 [US4] Test: duplicate identical completion is a no-op; conflicting duplicate is rejected (FR-027)
- [x] T052 [US4] Test: compaction drops old terminal entries and retains `STARTED` (FR-032)

## Phase 7: User Story 5 - Health and recovery (P3)

- [x] T053 [US5] Add the offline window and run disconnection in `packages/hub/src/nodes.ts` (FR-033)
- [x] T054 [US5] Add explicit recovery with all preconditions in `packages/hub/src/runs.ts`, restoring logical state only (FR-034, FR-036)
- [x] T055 [US5] Add new-generation and new-workspace enqueue after runtime start, treating the move as fencing not migration (FR-025, FR-035)
- [x] T056 [US5] Add stale-observation recording and empty post-restart inventory (FR-037)
- [x] T057 [US5] Test: heartbeat window marks `OFFLINE` and disconnects runs (FR-033)
- [x] T058 [US5] Test: each missing recovery precondition is named and blocks recovery (FR-034)
- [x] T059 [US5] Test: recovery issues generation N+1 and does not dispatch before the runtime exists (FR-035)
- [x] T060 [US5] Test: old node reconnecting with a stale generation cannot mutate state (FR-037)

## Phase 8: Polish

- [x] T061 [P] Add an end-to-end example with a fake hub and fake agent under `packages/node/examples`
- [x] T062 Measure idle hub and node memory on the 1 CPU / 2 GB host and record the number in README
- [x] T063 Review every named error code against `contracts/http-api.md` and remove unused ones
- [x] T064 Amend `docs/architecture.md` and README package status after implementation lands
