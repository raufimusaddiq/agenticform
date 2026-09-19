# PR #33 repair evidence

Status: **complete — all gates verified in-repo and on the live self-hosted deployment**. Updated September 16, 2026.

This document is the proof-of-completion record for the audit at
`docs/product-reliability-audit.md` (PR #33). The audit itself stays open as a
document; the repairs are merged on `main` and verified below.

- Implementation: PR #34, commit `d1b6821` ("fix: repair product reliability
  audit findings") on top of source baseline `a66ca9c`.
- Upgrade correction found by the real release path: PR #35, commit `08c24c9`
  (V9 backfills every task row before `SET NOT NULL`).
- Documentation records: PRs #36 and #37.
- Release: tags `v0.1.0` and `v0.1.1`; GHCR images for server, web, and node.
- Live verification: `https://agentic.investdx.biz.id` upgraded to pinned
  v0.1.1 digests; see [Live deployment](#live-deployment-v011-2026-09-16).
- CI: run 35089283604 on `846eaea` (current `main` HEAD) is green across all
  8 jobs, including the four end-to-end journeys.

The single item deliberately not claimed as done is a project-specific
application deployment through a project deploy runbook, which needs
owner-provided target configuration; see "Residual operator item".
Historical Sprint 15 records are unchanged. Scope: every workstream and exit
gate in PR #33, including its deployment-delivery clarification.

| Requirement | Current evidence | Remaining gate |
| --- | --- | --- |
| P0-1 deliverable contract | CLOSED (in-repo and live): persisted contract, structured evidence gates, deployment verification gate, end-to-end delivery journey, 172-test suite; v0.1.1 deployed and verified on the live stack with node upgrade to pinned digest (see [Live deployment](#live-deployment-v011-2026-09-16)) | Project-specific application deployment through a project deploy runbook remains owner work (see Residual operator item) |
| P0-2 actionable delegation/recovery | CLOSED (in-repo): task/generation-bound reports, explicit blockers, dependency references, handoff repair, browser journey, and UI dispatch disabled with a stated reason whenever status or an unresolved dependency makes retry unsafe | — |
| P0-3 authenticated streams | CLOSED (in-repo): async auth fix, both SSE streams through shipped proxy, 65s idle, invalid-token negatives, stale-state UI | — |
| P0-4 transport recovery | CLOSED (in-repo): ambiguous-task reset, bounded signaling, restart persistence, real node-loss journey (enroll→ONLINE→kill→OFFLINE→incident→agent DISCONNECTED, blocked task retains recovery reason); live node daemon reconnected from durable ledger on the released image | — |
| P0-5 installation/credentials | CLOSED (in-repo and live): DB-only dev path, consistent DB config, separate-key forwarding, real pg_dump/pg_restore restore with credential decryption; published v0.1.1 release installed on the live HTTPS target with pinned immutable digests; V9 migration applied to the production database with all 31 pre-existing tasks backfilled and no rows lost | — |
| P0-6 bounded operational delivery | CLOSED (in-repo): root delivery gate, delivery journey, wrong-SHA webhook negative, duplicate-dispatch ambiguity, invalid signature, duplicate delivery, wildcard-evasion negatives; rollback path proven during the live upgrade (see [Live deployment](#live-deployment-v011-2026-09-16)) | Project-specific application deployment through a project deploy runbook remains owner work (see Residual operator item) |
- Zero unintended writes for read-only scopes is directly tested in
`ReadOnlyScopeIsolationTest`: every non-WRITE profile starts Codex with a
read-only sandbox and is refused the WRITE capability, and creation of an
implementation-deliverable task for a non-writer profile is rejected. This closes
the zero-unintended-writes release gate for read-only/docs-only scopes.
| P1-2 release evidence | CLOSED: clean lockfile, UI build/test, 172-test suite, Go checks, 4 CI journey jobs; v0.1.1 images published to GHCR with pinned digests recorded below and this document plus the live-verification sections serve as the operator transcript | — |

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

Limits: the fixture validates the servlet/security/proxy lifecycle; the live
release verification below supplies the production-release evidence.

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

## Completion rule (superseded)

The original rule required all seven rows to stay open until every acceptance
requirement had direct evidence. That requirement is now met: in-repository
evidence, a published release, and live deployment evidence are recorded below.
The only intentionally unclaimed item is a project-specific application change
through a project deploy runbook; the release/control-plane upgrade itself is
verified and does not depend on that application-specific configuration.

## P0-1 deliverable contract and delivery gate

Implemented on the merged `main` branch (PR #34, commit `d1b6821`), with the
V9 legacy-upgrade correction in PR #35 (commit `08c24c9`):

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
- MERGED is now recorded too: a signed `pull_request` closed+merged webhook
  advances the bound root application task to the MERGED milestone (`handleMerge`),
  covered by `mergedPullRequestAdvancesRootToMergedStage`. Only the deployment
  runbook records the deployed revision, so merge evidence never masquerades as
  verified delivery. All seven UI-distinguishable milestones the audit names now
  have a real signal: implementation finished, review passed, merged, artifact
  published, deploying, deployment verified, delivered.
- ARTIFACT_PUBLISHED is now recorded: a successful build/release/publish workflow
  webhook bound to an application-root run marks the task published, so the UI can
  separate "CI passed" from "artifact published". MERGED remains a stage the UI can
  display; it is set only where an integration supplies a verified merge, and no
  milestone is ever claimed without a signal.
- Delivery milestones never regress: `TaskDeliveryStage.advanceTo` enforces forward
  movement, so a late signal cannot downgrade a task from DELIVERED back to
  DEPLOYING. Review-child completion records REVIEW_PASSED on the root, and an
  approved deployment/release runbook records DEPLOYING, so the UI distinguishes
  implementation-finished, review-passed, deploying, deployment-verified, and
  delivered as the audit requires. Covered by `TaskDeliveryStageTest`.
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

The live release/control-plane upgrade, pinned image digests, HTTPS health check,
database migration, task backfill, and node verification are recorded in the
Live deployment section below. A project-specific application deployment still
requires owner-provided target and runbook configuration.

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

Limits: extended mid-turn and permanent-node re-attach variants remain outside
the executed journey; the core loss/offline/incident/fencing path is proven by
the real node-loss journey and live node restart verification.

## P0-6 authorization surfaces retained and delivery gate binding

- Production deploy, production DML, persistent-data deletion, and user input
still seed REQUIRE_HUMAN; global wildcard ALLOW remains only the fallback. The
deterministic engine orders task > agent > project > global, exact action over
wildcard, exact environment over wildcard, with fail-closed on missing rules.
- One-shot preauthorization remains scoped to agent+task+action+environment with
exact effect digest and 5-minute TTL. Tests cover single-use, scope mismatches,
and wildcard-environment behavior.
- Evasion hole closed: rule ordering previously put scope rank above matcher
specificity, so a project/agent-scoped wildcard ALLOW silently erased the global
PRODUCTION_DEPLOY and DELETE_DATA REQUIRE_HUMAN guarantees. Ordering is now
matcher-first (exact action, exact environment, then scope, then id); new tests
prove agent-wildcard and project-wildcard ALLOW cannot bypass either gate while
deliberate task-scoped grants still work.
- Cleanup safety is now directly tested in `WorkspaceCleanupSafetyTest`: a path
outside the managed worktree root, an unknown branch, a dirty worktree, and an
unmerged branch are each refused; a clean merged worktree is removed. This
closes the audit's "unsafe-cleanup tests rejected" gate.
- Machine endpoints keep signature verification: `NodeSignatureVerifierTest`
covers invalid signature, replayed nonce, revoked node, expired timestamp, and
non-Ed25519 enrollment keys. Invalid and absent admin tokens are covered by
`AdminBearerAuthenticationFilterTest`, and stale generations by
`AgentRuntimeGenerationTest`.
- The runbook delivery gate added under P0-1 (root marked DELIVERED only after
successful deploy/release runbook with all-step evidence, target environment,
exact revision) binds routine authorized deployment into the new deliverable
contract. Destructive steps still require REQUIRE_HUMAN per seed policy; the
executor refuses ambiguous STARTED replay.
- No standing silent migration: existing installations keep their effective
policy matrix; no new auto-ALLOW path was introduced.

Evidence: DeterministicPolicyEngineTest (7 tests including the two
wildcard-evasion negatives), PolicyPreauthorizationServiceTest (3 tests),
HumanApprovalPolicyTest (10 tests), ExternalWorkflowServiceTest (4 tests
including wrong-SHA and duplicate-dispatch negatives), GitHubWebhookServiceTest
(3 tests including invalid signature and duplicate delivery), and the disposable
end-to-end runbook delivery journey. All pass in the current 172-test suite.
The production control-plane release and authorization safeguards are verified
live. A project-specific deploy runbook and application target remain owner work.

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
165 tests, zero failures/errors, two skipped (proxy-only idle test and the restore-only test when no restore database is configured). This closes
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
HTTPS/Traefik termination and real node enrollment are separately verified on the
live deployment recorded below.

CI confirmation: run 35016336485 on `62358c9` is green with all six jobs:
server, node, web, server-image, restore-evidence, clean-install-journey.

## Browser journey (executed) and remaining application-specific gate

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
is fenced to DISCONNECTED. A seeded BLOCKED task fixture with a stated recovery
reason is verified to survive the node loss with its reason intact, so the UI/API
always shows a recovery action rather than a bare failure. Executed locally
2026-09-15/16 and CI-verified (run 35027295624 on `f07b5dc`, `node-loss-journey` job
success; all 8 CI jobs green). Re-run after the fixture addition on 2026-09-16:
PASS.

Verified or separately scoped:

- Published-release install with immutable digests and HTTPS/Traefik termination
  is verified in the Live deployment section.
- A real end-to-end deployment to a configured application target, with its
  application-specific smoke transcript and artifact digest recorded on the root
  task, remains owner work.
- Extended node-loss variants (kill mid-turn with an active Codex runtime,
  permanent-node re-attach attempts) — the core loss/offline/incident/fencing
  path is covered.
- Release evidence record with matched published digests and operator transcript
  is recorded in the Live deployment section.

`tests/clean-install-journey.sh` supports `AGENTICFORM_JOURNEY_KEEP=1` to leave the
stack running for exactly that kind of manual/browser verification.

Production Compose tuning variables (`AGENTICFORM_SERVER_MEMORY`,
`AGENTICFORM_JAVA_TOOL_OPTIONS`) are documented in README and `.env.example`
(`feac0e4`), matching the repository rule that every Compose environment variable
is documented.

## PR #34 final state (2026-09-16)

See the Proof-of-completion summary at the end of this document for the current
authoritative status: PRs #34, #35, #36, and #37 are all merged. CI run
35089283604 on 846eaea is green across all 8 jobs, including the four end-to-end
journeys. PR #33 stays open as the original audit document; this proof document
records the completed repairs, the published release, and the live verification.
Every in-repository acceptance gate the evidence table marks closed has direct
command/test evidence above.

## Evidence re-verification

`sh tests/verify-audit-evidence.sh` re-runs the source-level evidence in one
command (server tests + migrations on a disposable database, Go test/vet, web
ci/test/build) and prints a pass/fail summary. Final recorded run: all steps PASS,
172 tests, Go and web checks green. CI run 35089283604 on `846eaea` passes all
8 jobs, including all four journeys. The four journey scripts (clean
install, browser, node loss, restore) provide the end-to-end layer and run as
CI jobs on every push.

## Proof-of-completion summary

The full objective for PR #33 is evidenced as follows on `main` (PRs #34-#37 merged):

| Evidence layer | Artifact | Status |
| --- | --- | --- |
| Fix implementation | PR #34 `d1b6821` (V9 contract, report identity, async auth, proxy, recovery, install, ops binding, delivery milestones, wildcard-evasion fix, cleanup-safety tests) + PR #35 `08c24c9` (V9 legacy backfill) | merged to `main` |
| Source-level re-run | `sh tests/verify-audit-evidence.sh` — 172 tests + Go + web | PASS, CI `server`/`node`/`web` |
| Clean install | `tests/clean-install-journey.sh` | PASS, CI `clean-install-journey` |
| Real browser | `tests/browser-journey.sh` (headless Chromium, 10 checks) | PASS, CI `browser-journey` |
| Credential restore | `tests/credential-restore.sh` (pg_dump/pg_restore) | PASS, CI `restore-evidence` |
| Node loss | `tests/node-recovery-journey.sh` (enroll→kill→OFFLINE→incident→DISCONNECTED) | PASS, CI `node-loss-journey` |
| Final CI | run 35089283604 on `846eaea` | all 8 jobs success (server, node, web, server-image, restore-evidence, clean-install-journey, browser-journey, node-loss-journey) |
| Published release | tags `v0.1.0` / `v0.1.1`; GHCR digests server `sha256:bde3eeca40de6f2a66c806ba37fd198238afd190c87d207a655e41f17e3c6524`, web `sha256:d8a26b28f55dc24b80a06375680614cc9f92f87da5b00efba0b6945ad84d9822`, node `sha256:6a3923c9ca29d90bf678b40de5db2ead7beea70f3e225782f9a9bf441d852e95` | published |
| Live deployment | `https://agentic.investdx.biz.id` on pinned v0.1.1, V9 applied, 31 tasks backfilled, node ONLINE | verified 2026-09-16 |

Every gate named in PR #33 is proven by a committed, CI-rerun script or test,
plus the published release and live deployment recorded below. The only
intentionally unclaimed item is a project-specific application deployment, which
requires owner-provided target and runbook configuration. Untracked `backups/`
and `web/web/` were left untouched;
all temporary test containers/networks were removed; the disposable test
PostgreSQL volume (`agenticform-audit-dev_development-postgres`) and the Maven
dependency cache (`agenticform-audit-maven-cache`) are retained for re-runs and
contain no production data.

## Task creation UI wired to the deliverable contract

The task-creation dialog now exposes the deliverable contract directly: requested
deliverable (GENERAL/ANALYSIS/DOCUMENTATION/IMPLEMENTATION/REVIEW/TEST), a
require-verified-deployment checkbox for implementation work, and a required
target environment field when deployment is required. The backend already
accepted these fields; this makes the contract creatable without the API alone.
Web `npm ci`, `npm test`, and `npm run build` pass.

## Release-gate mapping (PR #33 "Proposed release gates" -> evidence)

Each named release gate from PR #33 maps to the committed evidence above plus the
live deployment section. The only intentionally unclaimed item is the
project-specific application deployment, which needs owner-provided target
configuration.

| Release gate | Evidence | Status |
| --- | --- | --- |
| All four journeys reach their requested terminal gate | Delivery journey (implement→review→deploy→DELIVERED), analysis/docs-only completions, UI journeys, live release verification | CLOSED |
| Application changes deployed and verified in the configured target | Root DELIVERED only via `TaskEntity.recordVerifiedDelivery` after a runbook revision assert + health probe; revision/environment/run-ID persisted; wrong-revision run refused; live control-plane release verified on the configured HTTPS target | CLOSED in-repo; project application target remains owner work |
| Routine authorized deployments need no repeated human approval | Staging path runs QUEUED without approval when policy allows; approval path covered by policy tests; production still REQUIRE_HUMAN by seed | CLOSED in-repo |
| Destructive or out-of-scope effects remain separately gated | DELETE_DATA/PRODUCTION_DML seed gates, policy matcher ordering, wrong-SHA negative, wildcard-evasion fix | CLOSED in-repo |
| Zero unintended writes for read-only/docs-only scopes | `ReadOnlyScopeIsolationTest`: read-only sandbox per non-WRITE profile, WRITE refused, implementation deliverable rejected for non-writers | CLOSED in-repo |
- Zero duplicate side effects: duplicate terminal commands return the cached
  result (`NodeCommandCompletionHandlerTest`), duplicate webhooks are idempotent
  (`GitHubWebhookServiceTest`), and the recovery matrix is covered by
  `ExecutionNodeRecoveryTest` and `AgentRuntimeRecoveryServiceTest`.
| Zero duplicate side effects under the recovery matrix | Node ledger ambiguous-STARTED fence, duplicate-completion cache, duplicate-webhook idempotency, stale-generation fencing | CLOSED in-repo |
| Invalid-token / stale-generation / unsafe-cleanup tests rejected | Filter token matrix, runtime-generation fencing tests, `WorkspaceCleanupSafetyTest` refusals | CLOSED in-repo |
| Both event streams reconnect without committed-response exceptions | Real-Tomcat async regression reproduced then fixed; `stream-proxy.sh` through shipped nginx (65s idle) in CI | CLOSED in-repo |
| Restore verified with credentials | `tests/credential-restore.sh`: pg_dump/pg_restore into separate DB, credential decrypts, durable state intact | CLOSED in-repo |
| No unresolved P0 findings | All P0-1..P0-6 gates closed above by in-repo evidence plus the live release deployment | CLOSED |

## Operator runbook for the remaining gates (executed)

These steps closed the operator/release rows above. Steps 1–7 were executed on
the live self-hosted stack on 2026-09-16; step 8 is recorded in the Live
deployment section below.

1. Merge PR #34 into `main` — done (`d1b6821`), followed by the V9 upgrade fix in
   PR #35 (`08c24c9`).
2. Publish a release: `git tag v0.1.1 && git push origin v0.1.1`. The
   `.github/workflows/release.yml` job pushes
   `ghcr.io/raufimusaddiq/agenticform-{server,web,node}:v0.1.1` (and `latest`).
   `v0.1.0` was published first and used for the upgrade attempt below.
3. Record the published digests and pin `AGENTICFORM_NODE_IMAGE` to the
   `@sha256:` form (immutable) — done; digests are recorded in the Live
   deployment section.
4. On the deployment host with a real domain and TLS, set the `.env` from
   `.env.example` (`AGENTICFORM_PUBLIC_URL`/`AGENTICFORM_UI_ORIGIN` over HTTPS,
   `AGENTICFORM_ADMIN_TOKEN`, `AGENTICFORM_SECRET_KEY`,
   `AGENTICFORM_SERVER_IMAGE`/`AGENTICFORM_WEB_IMAGE` pinned to the recorded
   `v0.1.1` digests), then `docker compose -f docker-compose.prod.yml up -d` and
   confirm `/actuator/health` is UP over HTTPS — done; verified 2026-09-16.
5. Enroll an execution node from the UI and confirm it reports ONLINE with
   Codex available/authenticated — done; the live node reports ONLINE on the
   pinned v0.1.1 digest.
6. Register the deployment environment, service health URL, and a deploy
   runbook in the Operations view (revision assert + health check steps).
7. Create an application-change task with deliverable IMPLEMENTATION, deployment
   required, and the target environment; run it to completion and confirm the
   root task reaches DELIVERED with the environment, revision, run ID, and health
   evidence recorded in the task inspector — the gate is proven end-to-end on a
   disposable database with a real runbook; a project-specific application target
   is still owner work.
8. Capture the operator transcript (commands + observed output) and the release
   digests into this document, replacing the corresponding "Operator" cells
   above with the observed values — done; see the Live deployment section.

Step 8 is recorded below. The release rows are closed by the observed values;
the only item not claimed is a project-specific application deployment.

## Live-upgrade defect found and fixed during the v0.1.0 deployment (2026-09-16)

Deploying `v0.1.0` to the running self-hosted installation exposed a defect that no
empty-database test could catch:

- Symptom: `V9__task_deliverable_evidence.sql` failed with
  `column "deployment_required" of relation "tasks" contains null values` (SQL state
  23502) at the `SET NOT NULL` statement; the server then crash-looped.
- Cause: the backfill updated `deployment_required` only for `IMPLEMENTATION`
  rows, so pre-existing REVIEW / ARCHITECTURE / ORCHESTRATION / GENERAL rows stayed
  NULL. Every disposable test database was empty at migration time, so the
  conditional update was never exercised against real data.
- Fix: backfill `review_required`, `architecture_required`, `deployment_required`,
  `delivery_stage` and `deliverable` for **all** rows, plus an explicit NULL sweep
  before the `SET NOT NULL` statements.
- Regression test:
  `FlywayMigrationSmokeTest#migrationsUpgradeADatabaseThatAlreadyContainsNonImplementationTasks`
  migrates to V8, inserts one legacy task of each kind, then migrates to the head.
  Proven meaningful by running it against the unfixed migration: it failed with the
  exact production error (2 tests, 1 error) and passes with the fix (1 test, 0
  errors). Full suite after the fix: 172 tests, zero failures/errors.
- Rollback: the running installation was returned to its previous images
  (`agenticform-server:runtime-rehydrate-20260914`, `agenticform-web:main-4c0e912`)
  and verified healthy (UI HTTP 200, `/actuator/health` UP) before re-attempting the
  upgrade. A pre-upgrade `pg_dump` (SHA-256
  `042133ed6fd00da692e11415d584a3230f7c68a893ff17811e033abfe8c64569`) is retained at
  `/root/agenticform-backup/pre-upgrade-backup.dump`.

This is direct evidence for the audit's release gate: the release install path is
what surfaced the defect, and the fix is now covered by a regression test that
reproduces the real upgrade shape.

## Live deployment (v0.1.1, 2026-09-16)

- Fix merged via PR #35 (`08c24c9`); the release workflow published all three
  images. Pinned digests, re-verified with `docker buildx imagetools inspect`:

  | Image | Digest |
  | --- | --- |
  | `ghcr.io/raufimusaddiq/agenticform-server:v0.1.1` | `sha256:bde3eeca40de6f2a66c806ba37fd198238afd190c87d207a655e41f17e3c6524` |
  | `ghcr.io/raufimusaddiq/agenticform-web:v0.1.1` | `sha256:d8a26b28f55dc24b80a06375680614cc9f92f87da5b00efba0b6945ad84d9822` |
  | `ghcr.io/raufimusaddiq/agenticform-node:v0.1.1` | `sha256:6a3923c9ca29d90bf678b40de5db2ead7beea70f3e225782f9a9bf441d852e95` |

- Live stack `agentic.investdx.biz.id` upgraded to pinned `v0.1.1` digests,
  which is a real upgrade of an existing installation (not a clean install).
- Flyway V9 applied successfully on the production database: schema history shows
  `9|t`; all 31 pre-existing tasks backfilled with deliverable, deployment flag
  and delivery stage (REVIEW→REVIEW, ARCHITECTURE→ANALYSIS, etc.); no rows lost
  (26 COMPLETED / 4 BLOCKED / 1 FAILED preserved).
- Post-upgrade verification: server healthy, UI HTTP 200 over HTTPS,
  `/api/tasks` returns the new contract fields, `AGENTICFORM_VERSION=v0.1.1`.
- Rollback was exercised for real before the successful upgrade: after the v0.1.0
  migration failure the stack was returned to its previous images and verified
  healthy (UI HTTP 200, `/actuator/health` UP), proving the documented rollback
  path works on this installation.
- Re-verified at the end of this work: `https://agentic.investdx.biz.id` returned
  HTTP 200 and `/actuator/health` returned `{"status":"UP"}`.

This closes the P0-1/P0-5/P1-2 operator gates: published release, matched digests,
verified deployment of a real upgrade to a real target, and operator transcript.

### Execution node upgraded to the pinned release digest

- The live node daemon (`agenticform-node-local-runner`) was replaced with
  `ghcr.io/raufimusaddiq/agenticform-node@sha256:6a3923c9...` (v0.1.1), preserving
  its Ed25519 identity and command ledger through the mounted state directory.
- Post-swap: node reports `ONLINE` running node version `0.2.0`; the control plane
  shows 5 agents (Orchestrator, Architect, Backend, Code Reviewer, Operations) all
  `IDLE`; the superseded node identity remains `REVOKED`.
- The daemon reconnected and resumed recovery work from its durable ledger,
  demonstrating the documented restart behaviour on the released image.

### Residual operator item (explicitly not claimed as done)

A real application-change deployment through a project-specific deploy runbook
remains owner work: it requires the target application's environment, service
health endpoint and deployment procedure, which are outside this repository. The
delivery gate itself is proven end-to-end on a disposable database with a real
runbook (`DeliveryJourneyTestSupport`), and the release that carries that gate is
now installed and verified on the live target.
