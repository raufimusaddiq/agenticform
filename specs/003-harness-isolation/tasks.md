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
with the first story; phase 7 lands with the last. Phase 8 is the 2026-11-18
config-directory amendment (FR-009a..FR-009c) and lands as its own ticket after
this spec change merges.

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

- [x] T017 [US2] Bind declared state paths `rw`/`ro`, creating `rw` paths `0700` and skipping absent `ro` paths (FR-009, FR-011)
- [x] T018 [US2] Give an unknown harness an empty profile and empty home (FR-010)
- [x] T019 [US2] Test: `claude` sees `~/.claude` writable and no `~/.ssh` (FR-009, SC-002)
- [x] T020 [US2] Test: an unknown harness sees only the workspace and an empty home (FR-010)
- [x] T021 [US2] Test: no `AGENTICFORM_*` variable or node secret reaches the harness environment (FR-007, SC-006)
- [x] T022 [US2] Test: a profile change is a table edit; no runtime widening path exists (FR-012)
- [x] T023 [US2] Verify each harness's real state and config directories against its documentation and a real run; update the research and contract tables before they are final (FR-009)

## Phase 5: User Story 3 - No sandbox means no run (P1)

- [x] T024 [US3] Wire the self-test result into startup: `isolation.mode`, no advertised harnesses on failure (FR-013, FR-014)
- [x] T025 [US3] Fail a run with `isolation_unavailable` when the sandbox cannot start, with no unsandboxed retry (FR-015)
- [x] T026 [US3] Report `isolation` in the heartbeat (FR-016)
- [x] T027 [US3] Test: with `bwrap` hidden from `PATH`, startup reports `isolation_unavailable` and spawns no harness (FR-014, SC-003)
- [x] T028 [US3] Test: a sandbox that exists but cannot create the shape fails the self-test (FR-013)
- [x] T029 [US3] Test: a per-run sandbox failure fails the run and never retries unsandboxed (FR-015)
- [x] T030 [US3] Test: the heartbeat carries `mode`, `profile` and `selfTest` (FR-016)

## Phase 6: User Story 4 - The heartbeat tells the truth about harnesses (P1)

- [x] T031 [US4] Resolve the entry point without network, including the Bun cache check for `bunx` entries; ro-bind the resolved entry point's directory (and its interpreter/runtime dir when it is a script) into the sandbox and put it on the sandbox PATH, derived from the resolved result only, never from run input (FR-018, FR-019)
- [x] T032 [US4] Add the sandboxed ACP handshake probe and the classification table (FR-017, FR-018)
- [x] T033 [US4] Add the TTL cache, single-flight and invalidation after a failed run (FR-020, FR-021)
- [x] T034 [US4] Advertise only `ready` harnesses and add `harnessReport` to the heartbeat (FR-022)
- [x] T035 [US4] Map non-ready harnesses to `harness_missing`, `harness_unauthenticated` and `harness_unavailable` before any child starts (FR-023, FR-024)
- [x] T036 [US4] Name the harness and best-known status in the hub's `no_eligible_node` message (FR-025)
- [x] T037 [US4] Test: one ready, one `auth_required` and one absent harness produce the three statuses in one heartbeat (SC-004)
- [x] T038 [US4] Test: a run for each non-ready harness fails with its named code and spawns no child (FR-023, FR-024, SC-005)
- [x] T039 [US4] Test: a probe timeout yields `unknown` and the heartbeat keeps beating (FR-020)
- [x] T040 [US4] Test: a login is picked up after the TTL without a restart (FR-021)
- [x] T041 [US4] Test: a pinned version absent from the cache is `missing` and nothing is downloaded (FR-019)

## Phase 7: Polish

- [x] T042 [P] Amend `docs/architecture.md` with the isolation boundary and the gateway-backed limit
- [x] T043 [P] Amend `docs/harnesses.md` with the status meanings and the probe rules
- [x] T044 [P] Review every new error code against `contracts/isolation.md` §6 and `contracts/harness-detection.md` §5; remove unused ones
- [x] T045 [P] Record the sandbox self-test and probe cost on the 1 CPU / 2 GB host in the README
- [x] T046 [P] Confirm `bun run typecheck` and `bun test packages` pass with `bwrap` present and absent

## Phase 8: Config directory (amendment 2026-11-18)

- [x] T047 [US2] Add the `claude` profile `env` entry `CLAUDE_CONFIG_DIR=/home/agent/.claude` and validate at table load that every `env` value is absolute and, when it is a path under the sandbox home, matches a declared state entry (FR-009a, FR-009c)
- [x] T048 [US2] Create a missing config-directory state dir `0700`, then verify it is a directory and is readable and writable by the node user before building the sandbox (FR-009b)
- [x] T049 [US2] Map an unusable config directory to `unknown` with reason `state_dir_unusable`, so a run fails with `harness_unavailable` and no child starts (FR-009b, SC-007)
- [x] T050 [US2] Test: two consecutive `claude` runs share `.claude.json`; the second sees the first's onboarding flag, project trust and MCP server (FR-009c, SC-007)
- [x] T051 [US2] Test: `.claude.json` lives inside the bound state dir and not at the home root; the argv contains no file bind (FR-009a)
- [x] T052 [US2] Test: a relative value and a value with no matching state entry are rejected at table load, and no child starts (FR-009a)
- [x] T053 [US2] Test: a missing dir is created `0700`; a dir with mode `000` yields `state_dir_unusable` and `harness_unavailable`, with no child and no accepted empty config (FR-009b, SC-007)
- [x] T054 [P] Bump the profile version to `2` and update the heartbeat expectation in the tests (FR-016)
- [x] T055 [P] Document the operator migration in `docs/harnesses.md` and the README: stop `claude`, `mv ~/.claude.json ~/.claude/.claude.json`, export `CLAUDE_CONFIG_DIR=~/.claude` (FR-009a)

## Phase 9: Auth check (amendment 2026-11-19)

- [x] T056 Amend FR-018, FR-019 and FR-027 and add FR-018a; add the auth-check rows to `contracts/harness-detection.md` §2.2
- [x] T057 Declare `authCheck` as catalog data (`bin`, `args`, `loggedIn`) and add reason `auth_check_failed`; only `claude` declares one (`claude auth status`, bundled CLI)
- [x] T058 Run the check after a successful handshake as a sandboxed child with the run's profile; read stdout only, parse strictly, bound by the timeout, fail closed (FR-018a, FR-026, FR-027)
- [x] T059 Test: a fake status command printing true, false, garbage, a wrong type and nothing, exiting non-zero, hanging, or absent gives ready, unauthenticated, unknown, unknown, unknown, unknown, unknown, unknown
- [x] T060 Test: status output and stderr never reach the report or heartbeat; the check sees the run's sandbox (private HOME, cleared env)
- [x] T061 Test (skipped without the bundled CLI): real `claude` with a private HOME and an empty `.claude` is `unauthenticated`
- [x] T062 Confirm a prompt-time `Authentication required` failure invalidates the entry and the next heartbeat reports `unauthenticated`
- [x] T063 [P] Survey every catalog harness for a logged-out `session/new` gap; document the result and the limit in `docs/harnesses.md`
