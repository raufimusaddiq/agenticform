# Product repair plan — September 15, 2026

## Decision and scope

Keep the self-hosted-first objective: an operator registers a repository, delegates useful work, sees trustworthy progress, approves constrained effects, and receives a verifiable deliverable without SQL or undocumented repair. Stabilize that loop before adding Cloud, billing, another runtime, or more orchestration infrastructure.

This is a documentation-only audit and proposed implementation backlog, not a claim that the defects below are fixed. It complements the pending platform roadmap in PR #15; it does not replace that PR or declare its proposals shipped. The [Alpha exit gate](sprint-15-self-hosted-alpha-checklist.md#exit-gate) remains open.

Source baseline: `390eda2e855d60679fcaaad3c29caf168891cb5e` (`main`, PR #32). The original working branch at `a66ca9c` has identical tracked content. Findings cover the Spring control plane, React UI/proxy, Go execution node, deployment configuration, database aggregates, and product/architecture/recovery/operations specifications. Source review targeted lifecycle and user-facing contracts; it is not an exhaustive security certification or a review of every line.

No application code, production configuration, database records, credentials, deployments, or existing PRs were changed. Existing untracked `backups/` and `web/web/` were left alone. No disruptive restart, task dispatch, deployment, or production restore was performed.

## Evidence and limits

### Runtime logs

Fixed collection window: September 14, 2026, 09:00 UTC through September 15, 2026, 09:10 UTC. Counts cover retained output from the current containers, not removed containers or an uninterrupted service history. Counts are log observations, not unique incidents or availability percentages.

| Component | Evidence | Interpretation |
| --- | --- | --- |
| Server | 1,581 lines; 16 ERROR lines; 8 lines containing `response is already committed` | Repeated `AuthorizationDeniedException` with committed-response handling errors. First observed September 14 at 23:28:31 UTC; also September 15. Contradicts treating the September 13 SSE smoke test as continuing proof of reliability. Request path/root cause not established from these stack traces alone. |
| Node, including child runtime stderr | 213 lines; 50 heartbeat failures; 41 command-poll failures | Repeated HTTP header timeouts plus a connection reset. Cannot attribute all failures to the proxy or conclude a task was lost. |
| Web/Nginx | 53,914 lines; 104 upstream connection-refused errors and 104 HTTP 502 access records | 79 command polls, 16 heartbeats, 7 notifications, 2 server requests. These are upstream refusal failures, not application-policy denials. Correlate with deployment/startup timing before assigning root cause. |
| PostgreSQL | 580 lines; no ERROR/FATAL/WARNING matches | No matching database failures in this window; not proof of backup integrity or absence of slow queries. |
| Traefik | 8 lines; no selected error matches | Sparse logs cannot prove proxy health or explain node timeouts. |

Node tool-rejection messages included nine task-before-message rejections, five missing implementation-evidence rejections, four `No active task to report`, one operations-handoff rejection, and two unresolved-child rejections. These are contract friction evidence, not authorization checks to remove. Some runtime errors were policy rejections; error totals must not become a blanket failure rate.

Other HTTP 401s included automated `.env` probes. Keep those denied; do not classify every 401 as a sign-in regression. Raw logs, project contents, identifiers, credentials, and provider responses are deliberately excluded from this public document.

### Durable state snapshot

Read-only SQL on September 15, 2026, returned:

| Object | Observed state |
| --- | --- |
| Projects | 3 enabled: 2 GIT, 1 LOCAL_PATH |
| Agents | 5 IDLE |
| Tasks | 26 COMPLETED, 4 BLOCKED, 1 FAILED |
| Node commands | 160 SUCCEEDED, 2 FAILED |
| Remote runtime interactions | 570 CONSUMED, 81 FAILED |
| Message deliveries | 76 COMPLETED |
| Human approvals | 199 AUTO_APPROVED, 7 POLICY_DENIED, 1 ANSWERED |
| Execution nodes | 1 ONLINE, 1 REVOKED |
| Operational services / runbooks / operation runs | 0 / 0 / 0 |
| Incidents / signals | 1 OPEN, 1 INVESTIGATING / 2 CORRELATED |

These are lifetime aggregates, not the log window or a cohort success rate. Historical blocked tasks were not rewritten. IDLE agents do not prove completed objectives. Zero operation runs means this installation supplies no persisted evidence for the end-to-end operations deliverable. The September 13 checklist's statement that no historical node identity exists is now historical, not current inventory.

All five persistent containers visible on this host were included above. Registered projects do not imply their applications are deployed here: no separate project-application containers or registered service probes were present. Their external deployments, browser console logs, removed-container logs, and other hosts were not available in this audit. Do not claim those applications healthy; future operator evidence must identify their deployment/log source. No unrelated repository was cloned or changed.

### Release and validation evidence

The running server and node use local `runtime-rehydrate-20260914` images; the UI uses `main-4c0e912`. Labels alone do not prove their source content. This is not evidence that a matched published release passes the documented installation path.

GitHub CI run `34860976336` reports success for exact source SHA `390eda2`: server tests with a disposable PostgreSQL migration database, node tests/vet/build, web type-check/build, and container builds. Inspected workflow: [ci.yml](../.github/workflows/ci.yml). CI is source/build evidence, not proof of UI usability, proxy reconnect, node-loss recovery, or a completed operation. The web package has build/dev/preview scripts, no test script.

Host `mvn`, `go`, and `npm` are absent. Fresh container-based checks ran against a read-only source mount and temporary copies, separately from production:

- Maven/Java 21: 118 tests, zero failures/errors, one skipped migration test; passed September 15 at 09:21 UTC. Initial bridge-network dependency resolution failed; host-network retry passed.
- Go 1.24: `go test ./...` and `go vet ./...` passed.
- Node 24: clean `npm ci` failed with EUSAGE/missing lockfile entries. The CI-equivalent `npm install --no-audit --no-fund && npm run build` passed in a separate temporary copy; tracked lockfile/source were not changed. Initial bridge-network npm attempt timed out and was stopped before the host-network checks.
- Documentation: `git diff --check` passed; all 32 relative file links across this document and README resolve. Link checking verifies target files, not section anchors or runtime behavior.

The migration test calls Flyway `clean()` and must only receive a disposable database. Never point it at this installation. Its local skip is not a migration pass; the exact-baseline CI run above supplies separate migration execution evidence.

## Prioritized repair backlog

Priority P0 blocks a credible Alpha exit. P1 follows before broad daily-use rollout. Owners below are responsibilities, not assigned people. Every item requires an implementation PR and evidence; none is marked complete here.

### P0-1 — Make completion match the requested deliverable

Evidence: [TaskDispatchService](../server/src/main/java/com/agenticform/task/TaskDispatchService.java), `requiresImplementation`, returns true for every `ORCHESTRATION` task before checking read-only/review-only/design-only wording. `hasImplementationEvidence`, `hasReviewEvidence`, and `hasArchitectureEvidence` inspect prose substrings. Review text containing `fail` can reject “zero failures”; architecture text containing `blocker` can reject “no blockers”. The predicates do not themselves require a COMPLETED child, while the preceding unresolved-child check permits CANCELLED children. Therefore keyword-shaped reports are not reliable artifact verification.

Change: persist an explicit requested deliverable and required evidence at task creation. Distinguish analysis, documentation, implementation, review, and operations without inferring authorization from prompt words. Reuse task kinds where possible; add only the missing deliverable contract. Require completed, same-workflow evidence; cancelled children cannot satisfy required phases. Reports should carry structured outcome, artifact/revision references, validation status, blockers, and follow-up. Validate repository/workflow ownership server-side; keep historical prose readable, never silently mark it verified.

Better flow: a docs-only objective yields a docs-only PR; an analysis objective can finish without invented code; implementation cannot finish on plausible prose alone. Architecture/review requirements should reflect the requested change and risk, not force extra agents for every question.

Owner: task/orchestration backend, product. Acceptance:

- Read-only orchestration completes with analysis evidence and no code child.
- Documentation task completes with the requested document/PR and documentation checks; no application-code requirement is added.
- Implementation cannot complete with missing artifacts, unresolved required children, CANCELLED evidence, another workflow's report, or unverified validation.
- “No blockers” and “zero failures” do not fail lexical checks; saying “implemented; validation” does not prove implementation.
- UI distinguishes task execution finished, deliverable verified, PR opened, and PR merged. User-requested scope determines which is terminal.

### P0-2 — Make delegation, reporting, and recovery actionable

Evidence: [TaskWorkflowGate](../server/src/main/java/com/agenticform/task/TaskWorkflowGate.java) requires an assigned DISPATCHED/RUNNING task before work-directed messages. [AgenticformDynamicToolHandler](../server/src/main/java/com/agenticform/message/AgenticformDynamicToolHandler.java) rejects ordinary task creation for Operational Agents and directs callers to `handoff_to_operations`. Logs show callers hitting both boundaries. [App.tsx](../web/src/App.tsx) displays generic “Review blocker”/“Inspect failure” and a Dispatch button, not a reason-specific recovery contract.

Change: document and encode one supported sequence: create/reuse durable child task, satisfy dependencies, dispatch when eligible, then send optional task-linked context; hand operational work to the dedicated operations tool. Return stable error codes with task/approval/dependency references and safe next actions. Bind reports to explicit task identity and current runtime generation; a late report must never attach to a newer task. Reuse existing task IDs on retry.

Owner: orchestration backend, UI. Acceptance:

- An idle or busy recipient can receive a durable queued task without requiring a successful immediate work message.
- Dependency-blocked work stays blocked; UI identifies the dependency and responsible action.
- Missing-active-task reports return a reconcilable task reference or a precise stale result; no invented replacement task.
- Operations handoff reaches the Operational Agent; non-operational agents remain unable to execute operations.
- A blocked user can resolve the cause through supported UI/API actions without SQL; retry is disabled when safety cannot be established.

### P0-3 — Verify both event streams through the shipped proxy

Evidence: [controlPlaneEvents.ts](../web/src/controlPlaneEvents.ts) consumes `/api/events/stream` and `/api/agents/stream`. [nginx.conf](../web/nginx.conf) configures streaming/buffering/one-hour timeout only for the former; the agent stream falls under generic `/api/`. [SecurityConfig](../server/src/main/java/com/agenticform/config/SecurityConfig.java) uses stateless admin authorization; [AdminBearerAuthenticationFilter](../server/src/main/java/com/agenticform/config/AdminBearerAuthenticationFilter.java) has no explicit async-dispatch override. Logs prove committed-response errors, but do not prove that filter behavior is their sole cause.

Change: reproduce timeout/disconnect/error redispatch with the real servlet container, then preserve authenticated context through the intended async lifecycle. Give both streams explicit proxy streaming behavior. Show reconnecting/stale UI state and refresh authoritative snapshots after reconnect. Do not solve this by permitting unauthenticated API requests or hiding server exceptions.

Owner: backend security, web/proxy. Acceptance:

- Both streams deliver updates through the production proxy beyond its former default idle timeout.
- Browser close, network interruption, token rejection, server timeout, and reconnect produce no committed-response security exception.
- Missing/invalid tokens remain rejected; machine endpoints still verify signatures.
- Reconnection restores tasks/messages/approvals/node state without duplicate effects; stale state is visibly labeled, not shown as current.

### P0-4 — Prove safe recovery under transport failure

Evidence: node heartbeat/poll failures and proxy connection refusals; [AgentRuntimeRecoveryService](../server/src/main/java/com/agenticform/agent/AgentRuntimeRecoveryService.java), [ExecutionNodeHealthMonitor](../server/src/main/java/com/agenticform/node/ExecutionNodeHealthMonitor.java), and the [node daemon](../node/cmd/agenticform-node/main.go) own distinct transport/runtime/recovery transitions. PR #32 implements rehydration; it is an existing fix requiring release verification, not new work proposed by this audit.

Change: correlate failures by timestamp, request class, node, command, task, and generation. Separate control-plane unreachable, node offline, runtime unavailable, and ambiguous effect in UI and runbooks. Verify retry/backoff and timeout budgets against the deployed proxy. Reproduce before adjusting them; simply raising timeouts is not a fix for connection refusal.

Owner: node/backend reliability. Acceptance in a disposable environment:

- Restart the control plane during polling, restart the node while idle and during a turn, interrupt connectivity, and lose a node permanently.
- Preserve durable task identity; reject stale generations and duplicate completions; never automatically replay a ledger effect left ambiguous in STARTED.
- Pending approval prevents unsafe runtime movement; current inventory reconciles before replacement.
- Recovery reports what was restored and what was not. Local-only uncommitted files on a permanently lost node remain explicitly unrecoverable.
- Repeated transport failures produce one useful incident episode with bounded wake behavior, not an unbounded task/restart loop.

### P0-5 — Make installation and credential recovery reproducible

Evidence: `docker compose ps --all` from this checkout fails interpolation without release image/version/admin variables. [README](../README.md#local-development) nevertheless starts local development with only `docker compose up -d postgres`. [docker-compose.yml](../docker-compose.yml) hardcodes PostgreSQL database/healthcheck values while exposing user/database configuration elsewhere. `.env.example` advertises `AGENTICFORM_SECRET_KEY`, but root Compose does not forward it. Production Compose can load it through `.agenticform-secret.env`; setting it only in the interpolation `.env` is not equivalent. The live secret configuration was not inspected. [SecretBox](../server/src/main/java/com/agenticform/security/SecretBox.java) falls back to admin-token-derived encryption when no separate key reaches the app. Rotating that token can make existing encrypted repository credentials unreadable if no separate key was effective.

Change: provide a tested database-only development path; align documented configuration with both Compose variants. Forward the existing separate encryption key and define a safe migration/rotation procedure before changing existing installations. Back up the database, encryption material, configuration/release inventory, and required worktree/node state separately with restricted access. Never publish them as CI artifacts. Verify decryption and application behavior on restore, not just Flyway history.

Owner: packaging/security/operator documentation. Acceptance:

- A clean development checkout can start its database using exactly the documented prerequisites.
- Fresh self-hosted install uses one published release and immutable node digest; custom database/user values either work consistently or fail validation clearly.
- Set the separate key through the documented Compose path, store a test credential, rotate only admin authentication, then verify the credential still decrypts.
- Existing fallback-key installations migrate without losing credentials; missing/wrong key fails closed with an actionable recovery message.
- Restore into an isolated environment and verify projects, task/report history, policy, pending state, and encrypted credentials. Preserve the original database; no production `clean()` or destructive reset.

### P1-1 — Deliver the operations loop, not just its screens

Evidence: [operations contract](operations.md) promises policy-gated runbooks and durable external waits. This deployment has no runbooks, services, or operation runs. [OperationsView](../web/src/OperationsView.tsx), [ExternalWorkflowService](../server/src/main/java/com/agenticform/operation/ExternalWorkflowService.java), and [OperationalIncidentWakeService](../server/src/main/java/com/agenticform/operation/OperationalIncidentWakeService.java) provide implementation surfaces, not current end-to-end evidence.

Change: provide a guided, project-scoped first runbook/service setup and one safe CI verification scenario before any production deploy scenario. Explain missing integration configuration in the UI. Preserve immutable runbook snapshots, expected commit SHA, webhook verification, reconciliation fallback, policy decisions, and explicit retry for ambiguous remote wakes.

Owner: operations backend, UI/product. Acceptance: coding-to-operations handoff, REQUIRE_HUMAN approve/reject, signed workflow completion, missed-webhook reconciliation, timeout, failed wake, and final report are exercised on a disposable repository. Include wrong-SHA and duplicate-webhook negatives. A recovered health probe adds evidence; it does not silently resolve an incident. No production credentials enter agent prompts or node state.

### P1-2 — Replace milestone claims with release evidence

Evidence: [Sprint 15 audit checklist](sprint-15-audit-fix-checklist.md) records September 13 passes; the separate Alpha checklist still has open exit gates. Current logs and node inventory differ from historical assertions. CI builds the UI but has no browser journey test. A fresh Node 24/npm 11.19.0 container rejects `npm ci` with EUSAGE because the committed lockfile lacks platform-specific esbuild/rollup entries. CI uses `npm install`, so a green build does not establish clean-lockfile reproducibility.

Change: keep dated historical evidence, add a release-specific acceptance record, and distinguish implemented / unit-tested / integration-tested / dogfooded / released. A checkbox without version, environment, and result is not a release gate. Regenerate and verify the lockfile with the supported Node/npm toolchain, then use `npm ci` in CI and image builds. Add focused stream, first-use, task-delivery, approval, and recovery checks rather than redesigning the UI or introducing a new platform.

Owner: release/product. Acceptance: every claimed deliverable links its requirement, exact SHA/image digest, test or operator transcript, result, known limitation, and owner. Missing evidence stays open. Old verification remains historical rather than being silently rewritten.

## Delivery order and exit contract

1. Agree on deliverable semantics and the evidence schema (P0-1); reproduce streaming, transport, and credential/configuration failures in parallel.
2. Implement focused fixes with regression checks (P0-2 through P0-5). Preserve authorization, HTTPS, immutable images, outbound-only nodes, generation fencing, and fail-closed replay/cleanup throughout.
3. Validate a matched release on a clean disposable installation, then run the complete safe operations loop (P1-1). Capture UI evidence including empty, blocked, expired-auth, disconnected, and recovered states; keyboard actions and text status labels must work.
4. Dogfood analysis, docs-only PR, implementation/review, and approval-gated operation objectives through the UI. Record actual artifact references and elapsed time; no manual database repair. Publish the release evidence record (P1-2) before closing Alpha exit.

Proposed release gates: all four journeys produce the requested artifact; zero unintended writes for read-only/docs-only scopes; zero duplicate side effects under the recovery matrix; all invalid-token/stale-generation/unsafe-cleanup tests rejected; both event streams reconnect without committed-response exceptions; restore verified with credentials; no unresolved P0 findings. Measure first useful task time and blocker recovery time, but do not invent a baseline or market an unsupported latency/SLA target.

The deliverable of this PR is this repair plan. The deliverable of the subsequent implementation work is a verifiable user outcome, not more agents, containers marked healthy, green unit tests alone, or a report that merely says the work is done.

## Reproduction notes

Read logs with `docker logs --since 2026-09-14T09:00:00Z --until 2026-09-15T09:10:00Z <container>`. Resolve actual containers with `docker ps`; do not require loading deployment secrets just to inspect them. Aggregate status counts in a read-only SQL transaction. Remove credentials, identifiers, repository contents, and response payloads before sharing evidence.

Source/build checks: `cd server && mvn -B test`, `cd node && go test ./... && go vet ./...`, `cd web && npm ci --no-audit --no-fund && npm run build`. For the migration smoke test, provide only a newly created disposable database via `MIGRATION_TEST_DATABASE_*`. These checks do not substitute for the operator journeys above.
