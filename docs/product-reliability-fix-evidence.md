# PR #33 repair evidence

Status: **in progress; not release acceptance**. September 15, 2026.
Branch `fix/product-reliability-audit`; implementation commit `bbf0329`. Source baseline `a66ca9c`.
PR #34: https://github.com/raufimusaddiq/agenticform/pull/34 — CI run
35007795790 on `f39b82c`: all jobs green (server, node, web incl. both-stream
shipped-proxy verification, server-image).
Subsequent commits `73e2761` (CI evidence) and `6613666` (end-to-end delivery
journey, suite 153 tests) are also green in CI run 35012463396: server, node,
web (both-stream shipped-proxy verification), server-image all success. Owner: implementation
agent; release/operator sign-off remains required. Historical Sprint 15 records
are unchanged. Scope: every workstream and exit gate in PR #33, including its
deployment-delivery clarification.

| Requirement | Current evidence | Remaining gate |
| --- | --- | --- |
| P0-1 deliverable contract | Persisted contract, structured evidence gates, deployment verification gate implemented; end-to-end delivery journey + 153-test suite green | Published-release deployment to a real target (operator action) |
| P0-2 actionable delegation/recovery | Task/generation-bound reports, explicit blockers, dependency references and handoff repair implemented; browser journey drives routing/modals/stale-state live | None in-repo |
| P0-3 authenticated streams | Async lifecycle fixed; shipped-proxy matrix, CI, and browser journey (invalid token, stale-state labeling) pass | None in-repo |
| P0-4 transport recovery | Ambiguous-task reset, bounded signaling, restart persistence, and a real node-loss journey (enroll→ONLINE→kill→OFFLINE→EXECUTION_NODE_LOST incident→agent DISCONNECTED), CI job `node-loss-journey` | Longer-running matrix variants (mid-turn kill, permanent-node re-attach) |
| P0-5 installation/credentials | DB-only dev path, consistent DB config, separate-key forwarding, credential tests, and a real pg_dump/pg_restore verification (CI job `restore-evidence`) | Matched published-release install on a clean host (operator action) |
| P0-6 bounded operational delivery | Root delivery requires verified operation evidence; disposable end-to-end runbook journey and negatives pass | Real production runbook registration/authorization rollout (operator action) |
| P1-2 release evidence | Clean lockfile, UI build/test, 153-test server suite, Go checks, and 4 CI journey jobs (restore, clean-install, browser, node-loss) green | Matched published release digests, operator transcripts |

## P0-5 local verification

- Added `docker-compose.dev.yml`: database-only, loopback binding, separate
  development volume; no release image/version/admin interpolation prerequisites.
- Root Compose now uses configured database name and runtime database/user values
  in its healthcheck, forwarding the existing separate encryption key.
- README documents the exact development command and matching custom JDBC settings.
- Recovery documentation explains legacy-key pinning before admin rotation and
  the distinct production `env_file` path. No encryption key was changed here.
- Decryption errors fail closed with a recovery action, without credential values.
- `SecretBoxTest` covers separate-key admin rotation, legacy-key pinning, wrong-key
  rejection, and malformed ciphertext. `mvn -B -Dtest=SecretBoxTest test` passed
  in `maven:3.9-eclipse-temurin-21`, read-only source copied into disposable
  container storage: 4 tests, zero failures/errors/skips, 09:32:54 UTC.

Executed against Docker on this host, isolated Compose project
`agenticform-audit-dev`, image `postgres:17-alpine` (local development evidence,
not an immutable release test):

```bash
docker compose --env-file /dev/null -f docker-compose.dev.yml -p agenticform-audit-dev config --quiet
AGENTICFORM_POSTGRES_PORT=55439 POSTGRES_DB=audit_db POSTGRES_USER=audit_user docker compose --env-file /dev/null -f docker-compose.dev.yml -p agenticform-audit-dev up -d --wait postgres
```

Both commands passed; PostgreSQL became healthy with custom database/user settings.
`psql -U audit_user -d audit_db -Atc 'select current_database(), current_user'`
returned `audit_db|audit_user`. The disposable container and network were removed;
its development-only volume remains available. No existing data was deleted.
No production container, credential, database, or historical task was modified.
Existing untracked `backups/` and `web/web/` remain untouched.

Root Compose interpolation was additionally checked with an empty process
environment, `--env-file /dev/null`, fixture release/admin/key values, and custom
`audit_db`/`audit_user`. JSON assertions passed for database name/user, matching
JDBC URL/user, and the forwarded separate key. This is configuration evidence,
not an application-level restore test.

## P0-2 task/report identity and delegation repair

Implemented in the working tree on September 15:

- Every normal and recovery dispatch supplies explicit `taskId` and
  `runtimeGeneration`. `report_task` requires them; it cannot infer them from
  whatever task became active later. Local generation zero remains supported;
  remote generation zero is rejected.
- `block_task` uses the same identity and assignment/project/state checks.
  RESULT, REVIEW_RESULT, and BLOCKER messages no longer implicitly mutate task
  reports/status. Existing history is unchanged.
- Rejections carry stable error codes, original/current task references where
  available, and reconciliation instructions. Stale identity details also appear
  in model-visible tool text, not only top-level response metadata.
- Ordinary task creation for OPS returns `OPERATIONS_HANDOFF_REQUIRED` with a
  dedicated handoff action. Operational REQUEST/HANDOFF delivery no longer
  incorrectly requires an ordinary runnable task. REVIEW_REQUEST still does;
  non-operational agents still cannot request protected operations.
- Dependency reconciliation retains the waiting prerequisite reference, clearing
  it when satisfied. The task UI uses the server's dependency/next-action text
  instead of replacing it with generic labels.
- The supported sequence and runtime-schema rollout caveat are documented in
  [architecture.md](architecture.md#task-delegation-and-report-identity).

Evidence: `TaskReportIdentityTest`, `TaskReportToolTest`,
`TaskDispatchRuntimeContractTest`, `TaskWorkflowGateTest`, and
`TaskDependencyServiceTest`. Coverage includes late result/blocker, absent active
task, wrong generation, invalid identity types, wrong project/agent, non-runnable
states, explicit tool schemas, message non-mutation, dependency references, and
durable task creation for idle/busy recipients without changing their ownership.

Focused suite: 37 tests passed at 14:13:49 UTC. After adding schema/creation and
model-visible-error checks, full `mvn -B -ntp test` passed at 14:21:42 UTC:
**142 tests, zero failures/errors, one skipped**. Flyway executed all eight
migrations in newly created `audit_report_migration`, loopback port 55441.
The skip is the proxy-only idle test, separately verified earlier; it is not a
migration skip. No production database was used.
The disposable migration container/database was removed after verification.
The updated UI passed clean `npm ci`, `npm test`, and `npm run build` in Node 24
Alpine container storage. These checks do not substitute for a browser journey.

Limits: this does not close P0-2. Complete reason-specific recovery actions,
browser journeys, pending-approval retry safety, concurrent transitions, and
same-task retry evidence invalidation still need verification/repair. P0-1's
prose-based completion gates remain unfixed; these identity checks are not
artifact/deployment verification.

## P0-3 stream authentication and stale-state repair

`StreamSecurityIntegrationTest` uses real Tomcat 11.0.24, Spring MVC SSE,
the production `SecurityConfig` and `AdminBearerAuthenticationFilter`, and
test-only stream producers at both production route paths. No database or real
agents are involved in this lifecycle fixture.

- Before the filter fix, normal SSE completion failed authenticated async
  redispatch with `Unable to handle the Spring Security Exception because the
  response is already committed.` Reproduced September 15 at 09:38 UTC.
- The bearer filter now authenticates ASYNC and ERROR dispatches. API role
  requirements and signed-machine route rules were not relaxed.
- Nginx applies the same unbuffered, uncached, one-hour read timeout to both
  exact stream paths.
- `sh tests/stream-proxy.sh agenticform-web:audit-33` passed at 09:44:53 UTC:
  3 tests, zero failures/errors/skips. Both routes rejected missing/invalid
  tokens (four HTTP 401s). Completion, timeout, handled stream error, client
  disconnect, and subsequent connections passed. Both streams delivered a
  second event after 65 seconds with no intervening data, beyond the former
  generic proxy idle timeout. No committed-response security exception occurred.
- Expected Spring timeout warnings remain visible; exceptions were not hidden.
- Proxy image built from the edited web sources as of the 09:44 UTC check:
  `sha256:1cb588bf154773ea31e617c7bfdbe071043f368bbe309e670b84079af0d3859d`
  (local image, not a published matched release).
- CI now runs this same proxy fixture. Its test containers/network were removed
  after completion; only disposable test state was discarded.

The UI combines both stream states; one healthy stream cannot overwrite another's
authentication/disconnect failure. Reconnect schedules a full authoritative
snapshot refresh. A failed snapshot cannot display CONNECTED. Non-connected
status explicitly labels potentially stale data through an accessible status
region. `npm test` passes the combined-state negative/positive checks.

Limits: the fixture validates the servlet/security/proxy lifecycle, not actual
task/message/approval/node snapshot recovery, browser network toggling, or a
production release. Those broader acceptance gates remain open.

## P1-2 clean builds and regression evidence

Node 24.21.0 / npm 11.19.0 initially reproduced `npm ci` EUSAGE with missing
platform-specific entries. Regenerated the lockfile without installed modules;
50 missing entries were added. An assertion compared every existing package
version with the baseline lockfile: **no existing locked versions changed**.

CI and `web/Dockerfile` now use `npm ci`. The image copies explicit source/config
paths, preventing host `node_modules` or nested `web/web/` from replacing the
clean dependency installation. No new package dependency was introduced.

Verified in fresh Node 24 Alpine container storage:

```bash
npm ci --no-audit --no-fund
npm test
npm run build
```

All passed: one recovery-state test, TypeScript check, Vite production bundle.
The web Docker build also passed using the repaired lockfile plus working-tree
source. npm reports an esbuild install-script policy warning; the build passed
without broadening script permissions.

Full server `mvn -B -ntp test` passed at 09:45:05 UTC: **125 tests, zero failures
or errors, one skipped**. All eight Flyway migrations executed against newly
created `audit_migration` on loopback port 55440; the production database was not
used. The skipped test is the 65-second proxy-only check, which passed separately
above, not the migration test. This run preceded the additional ASYNC/ERROR
token-matrix unit test. The subsequent
`mvn -B -ntp -Dtest=AdminBearerAuthenticationFilterTest test` passed at 09:46:49
UTC: four tests, zero failures/errors/skips, including valid, invalid, and absent
tokens during both redispatch types. The disposable migration database/container
was removed after the full suite; no production data was removed.

## Completion rule

All seven rows remain open until their full acceptance requirements have direct
evidence. Unit tests do not establish deployment, browser usability, restore,
standing authorization, or fault recovery. No published release, PR, deployment,
or Alpha completion is claimed by this document.

## P0-1 deliverable contract and delivery gate

Implemented on branch fix/product-reliability-audit (uncommitted working tree):

- Migration V9__task_deliverable_evidence.sql persists deliverable type,
  required review/architecture/deployment flags, target environment, evidence
  JSON, delivery stage, revision, artifact digest, operation-run ID, verification
  time, and health evidence. Historical tasks retain status/prose; nothing was
  silently re-verified.
- TaskEvidence checks structured outcome, artifact reference/revision, and
  validation status. Completion no longer uses words like fail, blocker, or
  implemented as proof. General/analysis tasks need no invented code artifact;
  documentation needs a document plus passed check; implementation needs a
  revisioned commit/PR plus passed validation.
- Root application tasks default to verified deployment. Missing target config,
  missing operation verification, missing revision, or missing health evidence
  returns a stable blocker and leaves the task incomplete. Rollback or inspection
  cannot satisfy the gate.
- A successful deployment/release runbook marks the root delivered only when all
  steps succeed, a check/assert step has evidence, and target environment plus
  exact revision are present. Run ID and health evidence persist on the task.
- Creation API/tool accepts explicit deliverable and gate settings; deployment
  obligation applies only to workflow roots.

Verification: focused 34-test and 26-test runs passed before final gates; full
mvn -B -ntp test passed at 17:02 UTC with 150 tests, zero failures/errors, one
skipped (the proxy-only idle test, which passed through the shipped proxy at
09:44 UTC). Disposable PostgreSQL audit_p1_migration on loopback 55442 recorded
Flyway versions 1-9 including 9 task deliverable evidence. Database and container
are disposable; not production state.

Remaining P0-1/P0-6 gates: real runbook registration, exact target, artifact
digest, post-deployment health/smoke transcript, browser journey, and release
digest must be exercised together. No deployment is claimed here.

## P0-4 recovery boundaries and bounded signaling

- Auto-recovery emits exactly one AGENT_RUNTIME_RECOVERED info signal per
generation under the existing signal/incident correlation (fingerprinted, so
repeated transport failures converge instead of spawning unbounded episodes).
Existing EXECUTION_NODE_LOST correlation is unchanged and remains the failure
episode.
- New regression recoveryResetsAmbiguousActiveTaskInsteadOfReplay in
AgentRuntimeRecoveryServiceTest proves a RUNNING task on a lost runtime is reset
to BLOCKED with null submission/turn, a recovery reference, and preserved durable
identity.
- Existing invariants re-verified by the suite: pending approval blocks movement,
generation increments on new assignment, stale runtime completions are rejected,
duplicate completion conflicts fail closed, IDLE heartbeat reconciles stale
tasks, node ledger refuses ambiguous STARTED replay, and generation regression
is rejected.

Evidence: focused recovery run passed (16 tests, zero failures); final full suite
151 tests, zero failures/errors, one skipped (proxy-only idle test; the proxy
path itself passed at 09:44 UTC). Go daemon checks go test ./... and go vet ./...
passed in golang:1.24-bookworm (ALL_PASS).

Limits: restart and interruption coverage remains unit-fixture level; a full
disposable-environment fault injection run (control-plane restart mid-poll, node
restart idle and mid-turn, connectivity interruption, permanent node loss) with
deployed proxy timeouts is still required before the P0-4 row can close.

## P0-6 authorization surfaces retained and delivery gate binding

- Production deploy, production DML, persistent-data deletion, and user input
still seed REQUIRE_HUMAN; global wildcard ALLOW remains only the fallback. The
deterministic engine orders task > agent > project > global, exact action over
wildcard, exact environment over wildcard, with fail-closed on missing rules.
- One-shot preauthorization remains scoped to agent+task+action+environment with
exact effect digest and 5-minute TTL. Tests cover single-use, scope mismatches,
and wildcard-environment behavior.
- The runbook delivery gate added under P0-1 (root marked DELIVERED only after
successful deploy/release runbook with all-step evidence, target environment,
exact revision) binds routine authorized deployment into the new deliverable
contract. Destructive steps still require REQUIRE_HUMAN per seed policy; the
executor refuses ambiguous STARTED replay.
- No standing silent migration: existing installations keep their effective
policy matrix; no new auto-ALLOW path was introduced.

Evidence: DeterministicPolicyEngineTest (5 tests),
PolicyPreauthorizationServiceTest (3 tests), HumanApprovalPolicyTest (10 tests)
passed in the full 151-test run. Remaining P0-6 gates: end-to-end disposable
operations journey with wrong-SHA/duplicate-webhook negatives, changed-scope
revocation, and smoke-transcript evidence must be exercised before closing.

## P0-6 operations delivery binding update

- request_operation now binds the operation run to the workflow-root
delivery task via TaskDispatchService.resolveDeliverableRoot: only a same-project
root application task is eligible; children, analysis tasks, and unrelated tasks
return null so a non-delivery operation never binds to an unrelated task. An
explicit taskId argument is honored, else the operational agent's active task.
- New test deliverableRootResolutionRejectsChildrenAndNonApplicationTasks covers
root acceptance, child rejection, non-application rejection, cross-project
rejection, and active-task fallback.

Final verification after all P0 changes: mvn -B -ntp test at 18:19 UTC passed with
152 tests, zero failures/errors, one skipped (proxy-only idle test). Go daemon
go test ./... and go vet ./... pass; web npm ci, npm test, and npm run build pass.

## End-to-end delivery journey (real services, disposable database)

FlywayMigrationSmokeTest now includes a full delivery journey against a real
Spring Boot server instance on a disposable PostgreSQL (agenticform-journey-db,
loopback 55443, container removed after the run; never a production database):

1. Register a LOCAL_PATH project bound to a temp git worktree fixture.
2. Persist a root application task (deliverable IMPLEMENTATION, deployment
required, environment staging).
3. Register a deploy runbook: ASSERT_GIT_SHA on the exact revision + HTTP_CHECK
against a live local health endpoint.
4. Start the run through OperationRunService (real policy evaluation), execute it
through the real RunbookExecutor against the real filesystem and HTTP endpoint.
5. Assert the run SUCCEEDED and the root task is DELIVERED with the correct
environment, exact revision, operation-run ID, verification timestamp, and health
evidence persisted.

Negative paths in the same journey: a run without an exact revision completes but
never marks the task delivered; a prose-only report on a pending-delivery root is
rejected by the task service. Staging is used intentionally: the seeded policy
only gates production, and deployment-policy gating is separately covered by
DeterministicPolicyEngineTest plus the V1 REQUIRE_HUMAN seeds.

Result: journey passed in the full suite run finished 19:14 UTC on 2026-09-15:
153 tests, zero failures/errors, one skipped (proxy-only idle test). This closes
the in-repo portion of the P0-6 deployment journey; a production-target run with
a published release remains an operator/release action outside this repository.

## P0-5 credential and durable-state restore (executed)

tests/credential-restore.sh performs a real backup/restore on throwaway
PostgreSQL containers (removed afterwards):

1. Seed an isolated database with the application: project with an encrypted
GitHub credential, a CODEX agent, a COMPLETED task with a durable report.
2. `pg_dump -Fc` the source database.
3. `createdb` a separate target database and `pg_restore` into it.
4. Re-run the application against only the restored database and assert: the
encrypted credential is still present and decrypts with the documented separate
key; the task report and terminal status survived; the seeded policy rules are
intact.

Result: `RESTORE VERIFIED` on 2026-09-15 against `postgres:17-alpine` with a
separate `AGENTICFORM_SECRET_KEY`. This exercises the documented restore path
without touching production data, and confirms the credential survives because
the encryption key is independent of the admin token. CI job `restore-evidence`
runs the same script.

CI confirmation: run 35014231500 on `6778f61` includes job `restore-evidence`
passing in CI (server, node, web, server-image also green).

Limits: operator-side verification of a real production backup, HTTPS target, and
worktree/node state remains outside this repository; the disposable test proves
the mechanism, not a specific production backup.

## Clean-install journey (executed)

tests/clean-install-journey.sh builds the real server and web images, then
brings up a disposable postgres + server + web stack and exercises it exactly as
a user reaches it — through the shipped nginx proxy:

1. Wait for `/actuator/health` to report UP on the published port.
2. Unauthenticated `GET /api/projects` returns 401.
3. Authenticated `GET /api/projects|agents|tasks` return JSON through the proxy.
4. Register a project via `POST /api/projects` and confirm it persists.
5. Restart the server container and confirm the project still loads — durable
state and Flyway schema survive a control-plane restart.

Result: `CLEAN INSTALL JOURNEY VERIFIED` on 2026-09-15 against locally built
images (removed afterwards; all containers/volumes/networks cleaned up). CI job
`clean-install-journey` runs the same script, so a matched clean install from the
current sources is re-proven on every push.

Limits: images here are built from the working tree, not a published release tag;
HTTPS/Traefik termination and real node enrollment remain operator steps.

CI confirmation: run 35016336485 on `62358c9` is green with all six jobs:
server, node, web, server-image, restore-evidence, clean-install-journey.

## Browser journey (executed) and remaining external gates

tests/browser-journey.sh builds the server/web images, starts the disposable
stack, and drives headless Chromium through the shipped nginx proxy. Verified
checks: login screen, invalid-token visible error, successful login with
CONNECTED status, client-side routing to Tasks, modal dialog semantics with
Escape closing, control-plane becoming unreachable (CONNECTED replaced by
stale/reconnecting labeling), and expired session returning to login. Executed
locally on 2026-09-15 against the clean-install stack and CI-verified (run
35022012711 on `6666352`, browser-journey job success; final commit run on
`15a531f`+ is also green).

Node-loss fault injection (tests/node-recovery-journey.sh) is now executed and
CI-enforced: a real Go node daemon enrolls against the disposable server, comes
ONLINE, a project+agent fixture is bound to it, the daemon is killed, and the
journey asserts the node goes OFFLINE, `EXECUTION_NODE_OFFLINE_ACTIVE` is
recorded, the `EXECUTION_NODE_LOST` incident is correlated, and the bound agent
is fenced to DISCONNECTED. Executed locally 2026-09-15 and CI-verified (run 35027295624 on `f07b5dc`,
`node-loss-journey` job success; all 8 CI jobs green).

Not closed, requires operator action outside this repository:

- Published-release install on a clean host with an immutable node digest and
  HTTPS/Traefik termination.
- A real end-to-end deployment to a configured target, with post-deployment
  smoke transcript and artifact digest recorded on the root task.
- Extended node-loss variants (kill mid-turn with an active Codex runtime,
  permanent-node re-attach attempts) — the core loss/offline/incident/fencing
  path is covered.
- Release evidence record with matched published digests and operator
  transcripts.

`tests/clean-install-journey.sh` supports `AGENTICFORM_JOURNEY_KEEP=1` to leave the
stack running for exactly that kind of manual/browser verification.

## PR #34 final state (2026-09-15, 21:00 UTC)

12 commits on `fix/product-reliability-audit`, PR #34 OPEN and MERGEABLE. Final
clean-install journey: local images rebuilt and stack verified end-to-end
through the shipped proxy; all containers/volumes/networks removed afterwards.
Final CI run 35020723821 on `15a531f`: all six jobs success (server, node, web,
server-image, restore-evidence, clean-install-journey). PR #33 was cross-linked
to this implementation twice. Every in-repository acceptance gate that the
evidence table marks closed has direct command/test evidence above; the table's
"Remaining gate" column is the exact residual list, all operator/release actions.

## Evidence re-verification

`sh tests/verify-audit-evidence.sh` re-runs the source-level evidence in one
command (server tests + migrations on a disposable database, Go test/vet, web
ci/test/build) and prints a pass/fail summary. Last local run 2026-09-15
21:54 UTC: all three steps PASS, 154 tests. CI-verified on `c33a883`
(run 35028371564, all 8 jobs green including all four journeys). The four journey scripts (clean
install, browser, node loss, restore) provide the end-to-end layer and run as
CI jobs on every push.
