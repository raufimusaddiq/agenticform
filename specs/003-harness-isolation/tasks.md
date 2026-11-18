---

description: "Task list for Harness Isolation and Presence"
---

# Tasks: Harness Isolation and Presence

**Input**: Design documents from `/specs/003-harness-isolation/`

**Tests**: Required by FR-001..FR-028 and constitution VI. Each guarantee in
`contracts/isolation.md` and `contracts/harness-detection.md` gets a test task.

**Prerequisite**: `specs/002-node-hub` implemented. `docs/node-hub-invariants.md`
and `packages/runtime` read as they are on main.

**Delivery**: one implement ticket per user story. Phases 1-2 are shared and land
with the first story; phase 7 lands with the last.

## Phase 1: Setup

- [x] T001 Add `AGENTICFORM_HARNESS_PROBE_TTL_SECONDS` and `AGENTICFORM_HARNESS_PROBE_TIMEOUT_SECONDS` to `packages/node/src/config.ts` with validation
- [x] T002 Document the two variables in the README environment table
- [x] T003 Add the optional `harnessReport` and `isolation` fields to `HeartbeatRequest` in `packages/protocol/src/index.ts` (types only)

## Phase 2: Foundation

- [x] T004 Add the profile table and `IsolationProfile` type in `packages/node/src/isolation.ts` (FR-009, FR-010)
- [x] T005 Add the argv builder with the fixed order from `contracts/isolation.md` §2 (FR-001, FR-006, FR-011)
- [x] T006 Add the environment allowlist and `--clearenv` handling (FR-007)
- [x] T007 Add workspace resolution and the `/` and home-root rejection (FR-008)
- [x] T008 Add the startup self-test with the write-denial check (FR-013)
- [x] T009 Add a fake sandboxed child that attempts writes and reports `auth_required` on request, under `packages/node/test/fake-harness.ts`

## Phase 3: User Story 1 - A run cannot write outside its workspace (P1)

- [x] T010 [US1] Apply the sandbox override in `packages/node/src/executor.ts` so every run spawns `bwrap -- ...` (FR-001, FR-004)
- [x] T011 [US1] Add the `write` and `read-only` workspace profiles, default `write` (FR-002)
- [x] T012 [US1] Give each run a private `/tmp` and home (FR-005)
- [x] T013 [US1] Test: a write inside the workspace succeeds; a write to a sibling project and to any path outside the workspace, private `/tmp`, private home and declared state dirs fails with `EROFS`; `/tmp` and `$HOME` are writable but private to the run (FR-003, FR-005, SC-001)
- [x] T014 [US1] Test: a `read-only` run cannot write inside the workspace (FR-002)
- [x] T015 [US1] Test: a symlinked workspace binds its target and the target's parent stays read-only (FR-008)
- [x] T016 [US1] Test: the harness is a separate child in its own process group and cancel stops the group (FR-004)

## Phase 4: User Story 2 - Each harness sees only its own state (P2)

- [ ] T017 [US2] Bind declared state paths `rw`/`ro`, creating `rw` paths `0700` and skipping absent `ro` paths (FR-009, FR-011)
- [ ] T018 [US2] Give an unknown harness an empty profile and empty home (FR-010)
- [ ] T019 [US2] Test: `claude` sees `~/.claude` writable and no `~/.ssh` (FR-009, SC-002)
- [ ] T020 [US2] Test: an unknown harness sees only the workspace and an empty home (FR-010)
- [ ] T021 [US2] Test: no `AGENTICFORM_*` variable or node secret reaches the harness environment (FR-007, SC-006)
- [ ] T022 [US2] Test: a profile change is a table edit; no runtime widening path exists (FR-012)
- [ ] T023 [US2] Verify each harness's real state and config directories against its documentation and a real run; update the research and contract tables before they are final (FR-009)

## Phase 5: User Story 3 - No sandbox means no run (P1)

- [ ] T024 [US3] Wire the self-test result into startup: `isolation.mode`, no advertised harnesses on failure (FR-013, FR-014)
- [ ] T025 [US3] Fail a run with `isolation_unavailable` when the sandbox cannot start, with no unsandboxed retry (FR-015)
- [ ] T026 [US3] Report `isolation` in the heartbeat (FR-016)
- [ ] T027 [US3] Test: with `bwrap` hidden from `PATH`, startup reports `isolation_unavailable` and spawns no harness (FR-014, SC-003)
- [ ] T028 [US3] Test: a sandbox that exists but cannot create the shape fails the self-test (FR-013)
- [ ] T029 [US3] Test: a per-run sandbox failure fails the run and never retries unsandboxed (FR-015)
- [ ] T030 [US3] Test: the heartbeat carries `mode`, `profile` and `selfTest` (FR-016)

## Phase 6: User Story 4 - The heartbeat tells the truth about harnesses (P1)

- [ ] T031 [US4] Add entry-point resolution without network, including the Bun cache check for `bunx` entries (FR-018, FR-019)
- [ ] T032 [US4] Add the sandboxed ACP handshake probe and the classification table (FR-017, FR-018)
- [ ] T033 [US4] Add the TTL cache, single-flight and invalidation after a failed run (FR-020, FR-021)
- [ ] T034 [US4] Advertise only `ready` harnesses and add `harnessReport` to the heartbeat (FR-022)
- [ ] T035 [US4] Map non-ready harnesses to `harness_missing`, `harness_unauthenticated` and `harness_unavailable` before any child starts (FR-023, FR-024)
- [ ] T036 [US4] Name the harness and best-known status in the hub's `no_eligible_node` message (FR-025)
- [ ] T037 [US4] Test: one ready, one `auth_required` and one absent harness produce the three statuses in one heartbeat (SC-004)
- [ ] T038 [US4] Test: a run for each non-ready harness fails with its named code and spawns no child (FR-023, FR-024, SC-005)
- [ ] T039 [US4] Test: a probe timeout yields `unknown` and the heartbeat keeps beating (FR-020)
- [ ] T040 [US4] Test: a login is picked up after the TTL without a restart (FR-021)
- [ ] T041 [US4] Test: a pinned version absent from the cache is `missing` and nothing is downloaded (FR-019)

## Phase 7: Polish

- [ ] T042 [P] Amend `docs/architecture.md` with the isolation boundary and the gateway-backed limit
- [ ] T043 [P] Amend `docs/harnesses.md` with the status meanings and the probe rules
- [ ] T044 [P] Review every new error code against `contracts/isolation.md` §6 and `contracts/harness-detection.md` §5; remove unused ones
- [ ] T045 [P] Record the sandbox self-test and probe cost on the 1 CPU / 2 GB host in the README
- [ ] T046 [P] Confirm `bun run typecheck` and `bun test packages` pass with `bwrap` present and absent