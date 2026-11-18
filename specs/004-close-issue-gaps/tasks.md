---

description: "Task list for Close Open Issue Gaps"
---

# Tasks: Close Open Issue Gaps

**Input**: Design documents from `/specs/004-close-issue-gaps/`

**Tests**: Required by constitution VI and AGENTS.md. Every failure boundary in
`contracts/http-api.md` and `contracts/node-protocol.md` gets a test task, and
tests are written before the code they cover.

**Prerequisite**: specs 001–003 implemented on `main`. Read `plan.md` §Design Notes
and `data-model.md` before starting any phase.

**Delivery**: one rig ticket per phase. Phases 1–2 land with US1. US4 and US5
include manual work on Linux hosts, marked **(manual)**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on unfinished tasks)
- **[Story]**: the user story the task belongs to (US1–US5)

---

## Phase 1: Setup

- [ ] T001 Add the error codes `forbidden`, `name_taken`, `permission_resolved`, `permission_expired`, `permission_unsupported`, `parent_not_found` and `depth_exceeded` to the error-code union in `packages/protocol/src/index.ts`, and map their HTTP statuses (403, 409, 409, 409, 409, 404, 422) in `packages/hub/src/errors.ts`
- [ ] T002 [P] Add `AGENTICFORM_RUN_MAX_DEPTH` (integer, default 3, minimum 0; reject a non-integer at startup) to `packages/hub/src/config.ts`, and document it and `AGENTICFORM_TOKEN` in the environment table in `README.md`

---

## Phase 2: Foundational

**Purpose**: the migrations every story needs. No story starts until they are in.

- [ ] T003 Append migrations 4, 5 and 6 to `MIGRATIONS` in `packages/hub/src/schema.ts` and bump `SCHEMA_VERSION` to 6. Copy the columns exactly from `data-model.md`:
  - `caller_tokens`: `id` TEXT PK, `name` TEXT NOT NULL, `scope` TEXT NOT NULL, `digest` TEXT NOT NULL, `created_at`, `last_used_at` NULL, `revoked_at` NULL
  - `permission_requests`: PK `(run_id, generation, tool_call_id)`, FK `runs(id)`, `status` IN (`pending`,`answered`,`resolved`,`timed_out`,`cancelled`), `decision` IN (`allow`,`deny`) or NULL
  - `runs`: `parent_run_id TEXT NULL REFERENCES runs(id)` and `depth INTEGER NOT NULL DEFAULT 0`

  Add `CallerTokenRow` and `PermissionRequestRow`, and extend `RunRow`.
- [ ] T004 Test in `packages/hub/test/config.test.ts`: a version-3 database migrates to 6 with no data loss on existing runs, and a version-7 database is refused

**Checkpoint**: the schema is ready, and US1, US2 and US3 can start in parallel after T003.

---

## Phase 3: User Story 1 – A calling agent works without the admin token (P1) 🎯 MVP

**Goal**: a revocable `runs`-scoped token can submit, read, follow and cancel runs and list nodes, and nothing else (FR-001..FR-006).

**Independent Test**: issue a token, run submit, follow and cancel through HTTP, CLI and MCP; every owner-only route is refused; after revoke, the next call and the open follow are refused.

### Tests for User Story 1

- [ ] T005 [P] [US1] Contract test in `packages/hub/test/tokens.test.ts`, a table over every caller route in plan.md §"Principal and route guard" × {admin, runs, revoked runs, none}: allowed routes return their normal status; a `runs` token on an admin route returns `403 forbidden` with no state change; revoked or no token returns `401 unauthorized`; a route missing from the table is admin-only
- [ ] T006 [P] [US1] Test in `packages/hub/test/tokens.test.ts`, token lifecycle:
  - issue returns `afc_<id>_<secret>` once;
  - `GET /v1/tokens` never includes `token` or `digest`;
  - name must be 1–64 chars, unique among active tokens (`name_taken`), and scope other than `runs` is `invalid_input`;
  - revoke is idempotent;
  - `last_used_at` is written at most once per 60 s
- [ ] T007 [P] [US1] Test in `packages/hub/test/tokens.test.ts`: an SSE follow with a `runs` token receives `event: error` `{"code":"unauthorized"}` and closes within 30 s of revoke (FR-003, SC-002)
- [ ] T008 [P] [US1] Test in `packages/hub/test/tokens.test.ts`: a token secret appears in no event row, no captured log line, and no UI asset served by the hub (FR-004)

### Implementation for User Story 1

- [ ] T009 [US1] Create `packages/hub/src/tokens.ts`, following research R1:
  - `issueToken(db, name, scope)`: id is 12 base32 chars, secret is 32 random bytes in base64url; store hex SHA-256 of the whole token;
  - `listTokens(db)`;
  - `revokeToken(db, id)`;
  - `authenticateToken(db, token, now)`: parse `afc_<id>_<secret>`, look up by id, `timingSafeEqual` on the digest, reject `revoked_at`, update `last_used_at` at most once per 60 s
- [ ] T010 [US1] In `packages/hub/src/server.ts`:
  - replace `authenticateBearer` with `authenticate(config, db, headers): Principal` (admin first, unchanged compare; then `authenticateToken`);
  - add the route-to-scope table from plan.md §"Principal and route guard", default admin-only;
  - wire `POST /v1/tokens`, `GET /v1/tokens` and `POST /v1/tokens/{id}/revoke` (admin only)
- [ ] T011 [US1] In `sse()` in `packages/hub/src/server.ts`, re-run `authenticate` at each keepalive, and on failure send `event: error` `data: {"code":"unauthorized"}` and close (research R3)
- [ ] T012 [P] [US1] Add `issueToken`, `listTokens` and `revokeToken` to `packages/client/src/index.ts`. The client reads `AGENTICFORM_ADMIN_TOKEN`, else `AGENTICFORM_TOKEN`, from the environment only
- [ ] T013 [P] [US1] Add `af token issue <name>`, `af token list` and `af token revoke <id>` to `packages/cli/bin/af.ts`. Accept the token from `AGENTICFORM_ADMIN_TOKEN` or `AGENTICFORM_TOKEN` only, never as an argument
- [ ] T014 [P] [US1] Make `packages/mcp/bin/mcp.ts` accept `AGENTICFORM_TOKEN` when `AGENTICFORM_ADMIN_TOKEN` is unset, and return the hub's `forbidden` error unchanged
- [ ] T015 [US1] Test in `packages/cli/test` and `packages/mcp/test`: with only `AGENTICFORM_TOKEN` set to a `runs` token, `start_run`/`af run start`, follow and cancel succeed against a real hub, and `af token list` fails with `forbidden` (SC-001)

**Checkpoint**: US1 is shippable; callers no longer need the admin token.

---

## Phase 4: User Story 2 – The owner answers a run's permission request remotely (P1)

**Goal**: pending requests are visible; only the admin token answers allow or deny; silence denies at 300 s; each request ends in exactly one outcome (FR-007..FR-013).

**Independent Test**: a fake agent asks permission once; allow through each interface continues the run; deny is seen as a denial; no answer is denied at the timeout; a second answer is refused.

### Tests for User Story 2

- [ ] T016 [P] [US2] Test in `packages/hub/test/permissions.test.ts`, state machine from data-model.md:
  - `permission.requested` creates `pending` with `expires_at = requested_at + 300000`;
  - an admin answer moves it to `answered` and enqueues one `permission.answer`;
  - `permission.resolved` moves `answered` to `resolved`, and `pending` to `timed_out` after expiry or `resolved` before it;
  - nothing leaves a terminal state
- [ ] T017 [P] [US2] Test in `packages/hub/test/permissions.test.ts`, refusals:
  - `runs` token → `403 forbidden`;
  - decision not `allow`/`deny` → `invalid_input`;
  - second answer → `permission_resolved`;
  - after `expiresAt` → `permission_expired`;
  - node without `permissions.remote` → `permission_unsupported`;
  - old generation → `not_found`
- [ ] T018 [P] [US2] Test in `packages/hub/test/permissions.test.ts`: two concurrent answers to one request; exactly one returns 200 and exactly one command is enqueued (SC-003)
- [ ] T019 [P] [US2] Test in `packages/hub/test/permissions.test.ts`: cancel, failure, disconnect and generation fence each mark every `pending` or `answered` row of the run `cancelled`, in the same transaction as the run status change (FR-011)
- [ ] T020 [P] [US2] Test in `packages/hub/test/permissions.test.ts`: event append refuses a `permission.requested` whose `toolCallId` is over 128 chars, `title` over 256 or `kind` over 64, with `invalid_input` (FR-013)
- [ ] T021 [P] [US2] Real-process test in `packages/node/test/permissions.test.ts`, using the `permission` mode of `packages/runtime/test/fake-agent.ts` through a real hub and node:
  - allow reaches the agent;
  - deny reaches the agent;
  - no answer is denied at a shortened `permissionTimeoutMs`;
  - a duplicate `permission.answer` completes `{ applied: false }`;
  - a node restart leaves the request `cancelled` and never re-asks

### Implementation for User Story 2

- [ ] T022 [US2] In `packages/protocol/src/index.ts`, add `"permission.answer"` to `CommandType`, the payload `{ toolCallId, decision, generation, fingerprint }`, and `PermissionRequestView` exactly as in `contracts/http-api.md` §3
- [ ] T023 [US2] Create `packages/hub/src/permissions.ts`:
  - `recordRequested`, `recordResolved` and `cancelPending(db, runId)`;
  - `listPermissions(db, runId)`, current generation, options `["allow","deny"]`;
  - `answerPermission(db, runId, requestId, decision, now)`: a single `UPDATE … WHERE status='pending' AND expires_at > ?`, then enqueue, then insert the `permission.answered` event `{ requestId, decision, by: "admin" }`, all in one transaction
- [ ] T024 [US2] In `packages/hub/src/commands.ts`:
  - give `enqueueCommand` an optional idempotency key suffix, producing `run:{id}:permission.answer:{toolCallId}:{generation}`;
  - make `permission.answer` completion never change run status (like `run.inspect`);
  - call `cancelPending` wherever a run reaches a terminal status
- [ ] T025 [US2] In `appendEvents` in `packages/hub/src/events.ts`, call `recordRequested`/`recordResolved` for `permission.requested`/`permission.resolved` events, with the length bounds from T020
- [ ] T026 [US2] Wire `GET /v1/runs/{id}/permissions` (admin and runs) and `POST /v1/runs/{id}/permissions/{requestId}` (admin only) in `packages/hub/src/server.ts`, and add both to the route table from T010
- [ ] T027 [US2] In `packages/node/src/executor.ts`:
  - pass `onPermission` to `runtime.run`, registering a waiter in a map keyed by `runId:generation:toolCallId`;
  - handle `permission.answer` by resolving the waiter (`{ applied: true }`) or completing `{ applied: false }`;
  - drop waiters when the run ends
- [ ] T028 [US2] In `packages/node/src/poller.ts`, lease `permission.answer` in the control lane with `run.cancel` and `run.inspect`. In `packages/node/src/node.ts`, add `permissions.remote` to the heartbeat capabilities
- [ ] T029 [P] [US2] Add `listPermissions` and `answerPermission` to `packages/client/src/index.ts`; add `af run permissions <id>` and `af run answer <id> <requestId> allow|deny` to `packages/cli/bin/af.ts`; add the MCP tools `list_permissions` and `answer_permission` to `packages/mcp/bin/mcp.ts`
- [ ] T030 [P] [US2] Show pending requests with Allow and Deny buttons on the run view in `packages/hub/src/ui/app.js`, using the existing bearer flow; extend `packages/hub/test/ui.test.ts`
- [ ] T031 [US2] Amend `specs/002-node-hub/spec.md` Scope to note that remote permission answers are added by spec 004, and update `docs/architecture.md` with the permission flow diagram from plan.md

**Checkpoint**: harnesses that ask before acting can do useful work remotely.

---

## Phase 5: User Story 3 – A run started by an agent cannot spawn work without bound (P2)

**Goal**: optional `parentRunId`, stored depth, and `depth_exceeded` past the limit (FR-014..FR-017).

**Independent Test**: a chain of submissions stops at depth 3 with `depth_exceeded`, and no run is created past it.

### Tests for User Story 3

- [ ] T032 [P] [US3] Test in `packages/hub/test/runs.test.ts`:
  - a run without a parent has `depth` 0;
  - a child has `parent.depth + 1`;
  - depth 4 with the default limit fails with `422 depth_exceeded` and inserts no row;
  - an unknown parent is `404 parent_not_found`;
  - `AGENTICFORM_RUN_MAX_DEPTH=0` refuses any child
- [ ] T033 [P] [US3] Test in `packages/hub/test/runs.test.ts`: the same idempotency key with the same parent returns the existing run, and with a different parent returns `idempotency_conflict` (SC-004)

### Implementation for User Story 3

- [ ] T034 [US3] In `createRun` in `packages/hub/src/runs.ts`, validate `parentRunId`, compute `depth`, refuse past `config.maxDepth` before insert, store `parent_run_id` and `depth`, and add `parentRunId` and `depth` to the run view. Add `parentRunId?: string` to `RunRequest` in `packages/protocol/src/index.ts`
- [ ] T035 [P] [US3] Pass `parentRunId` through `startRun` in `packages/client/src/index.ts`, `--parent <id>` in `af run start` (`packages/cli/bin/af.ts`), and the `parentRunId` property of the MCP `start_run` tool (`packages/mcp/bin/mcp.ts`)

**Checkpoint**: agent-created chains are bounded.

---

## Phase 6: User Story 4 – The node is proven on real machines (P2)

**Goal**: soak, two-machine journey and packaging evidence (FR-018..FR-021).

**Independent Test**: run the scripts and the procedure on Linux hosts and read the recorded results.

- [ ] T036 [P] [US4] Create `scripts/soak.ts` per plan.md §Evidence, with flags `--hours` (default 4), `--restarts` (default 3) and `AGENTICFORM_SOAK_HARNESS`. It mixes complete, cancel, permission allow and permission timeout runs. It samples `VmRSS` of hub and node every 60 s, records harness process groups and checks them with `kill(-pgid, 0)`, and writes `soak-result.json` with the fields in data-model.md. It exits non-zero if any orphan or non-terminal run remains, or if final RSS exceeds 120% of the first-hour RSS (SC-005)
- [ ] T037 [P] [US4] Add a 2-minute smoke mode (`--minutes 2 --restarts 1`) of `scripts/soak.ts`, run by `bun test` through `packages/node/test/soak-smoke.test.ts`, skipped with a printed reason when `bwrap` is absent
- [ ] T038 [P] [US4] Create `scripts/package-node.ts`. It builds the node with `bun build --compile` and as a `bun install --production` tree, lists the contents, fails if anything beyond the node, its workspace dependencies and the runtime is included, and prints size and cold start to first heartbeat for both (FR-020)
- [ ] T039 [P] [US4] Create `docs/release-evidence.md`:
  - the two-machine journey from FR-019 as numbered steps: enrol, two harnesses ready, a run on each, a remote permission answer, stop the node mid-run and restart, stale generation rejected, a bad signature does not consume a nonce, `ss -ltn` shows no node listener;
  - an empty results table with host, date and versions columns
- [ ] T040 [US4] **(manual)** Run `scripts/soak.ts --hours 4 --restarts 3` on a Linux host and commit the result summary into `docs/release-evidence.md`
- [ ] T041 [US4] **(manual)** Run the two-machine journey from `docs/release-evidence.md` with two owner-authenticated harnesses and fill in its results table (SC-006)
- [ ] T042 [US4] **(manual)** Run `scripts/package-node.ts`, record the binary-versus-install decision with its numbers in `docs/release-evidence.md`, and update the README Memory section with the soak figures

**Checkpoint**: #79's and #81's evidence items exist.

---

## Phase 7: User Story 5 – Every issue says what is true (P3)

**Goal**: issue status matches the code (FR-022..FR-025).

**Independent Test**: every open rebuild issue has remaining work; every closed one links its evidence.

- [ ] T043 [P] [US5] **(manual)** Measure CI job-minutes per research R10 (`gh run list --workflow ci.yml`, 20 PR runs before `7947aef` and 20 after `14a1464`), post the median and total on #75, and close it (FR-024)
- [ ] T044 [US5] **(manual)** After US1–US3 merge, comment on #86 with the PRs and tests, and close it
- [ ] T045 [US5] **(manual)** After T040–T042, comment on #79 and #81 with `docs/release-evidence.md`, post the memory record on #73 stating that the legacy stack has no baseline (FR-021), and close #79 and #81
- [ ] T046 [US5] **(manual)** Amend #73's Goal and Scope to the execution-fabric direction and close it once every child is closed (FR-025)

---

## Phase 8: Polish

- [ ] T047 [P] Update `docs/architecture.md` and `README.md` for caller tokens, permission answers and lineage; remove any text that says every caller uses the admin token
- [ ] T048 [P] Review every new error code against `contracts/http-api.md` §2–4 and remove any that is unused
- [ ] T049 Confirm that `bun run typecheck` and `bun test packages` pass on Linux with `bwrap` present and absent, and that the protocol version is still 1

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → **Foundational (T003–T004)** → stories.
- **US1** has no story dependency. **US2** depends on T010, for its route table entries. **US3** has no story dependency.
- **US4**: T036–T039 can start any time. T036 needs US2 for its permission mixes. T040–T042 need US1–US3 merged.
- **US5**: T043 any time. T044 after US1–US3. T045 after T040–T042. T046 last.
- **Polish** after the code stories.

```text
T001,T002 ─▶ T003 ─▶ ┬─ US1 (T005–T015) ─▶ US2 (T016–T031) ─┐
                     └─ US3 (T032–T035) ─────────────────────┼─▶ T040–T042 ─▶ T044–T046
              T036–T039 (scripts, docs) ─────────────────────┘      T043 (any time)
```

## Parallel Examples

- **US1**: T005, T006, T007 and T008 together (one test file, separate `describe` blocks written before code); after T009–T011, T012, T013 and T014 together.
- **US2**: T016–T021 together; after T022–T028, T029 and T030 together.
- **US3**: T032 and T033 together; T035 after T034.
- **Across stories**: the US3 phase can run beside US1. T036–T039 can run beside any code phase.

## Implementation Strategy

1. **MVP**: Phases 1–3 (US1). Calling agents stop holding the admin token, which closes the largest security gap.
2. **US2**: makes remote runs useful for harnesses that ask permission.
3. **US3**: bounds agent-created chains.
4. **US4 → US5**: evidence on Linux hosts, then issue closure.

Each phase is one rig ticket with review on. The manual tasks stay with the owner.
