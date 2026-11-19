# Implementation Plan: Close Open Issue Gaps

**Branch**: `004-close-issue-gaps` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-close-issue-gaps/spec.md`

## Summary

Close the last acceptance gaps of #86, #79, #81, #75 and #73. There are three code
slices, in the hub with thin additions to node, client, CLI, MCP and UI:

1. **Caller tokens**: a hub-issued, revocable `runs`-scoped bearer token, stored
   as a SHA-256 digest and checked by the existing bearer middleware.
2. **Remote permission answers**: the node gives `runtime` a permission handler
   that waits for a hub `permission.answer` command. The hub records each request
   from the node's `permission.requested` event and lets only the admin token
   answer. The runtime's existing 300 s timeout stays the single deny-on-silence
   clock.
3. **Run lineage**: optional `parentRunId` on submission, a stored `depth`, and
   `depth_exceeded` past a configurable limit (default 3).

Two evidence slices produce scripts and recorded results rather than features: a
soak runner and the packaging test, a two-machine journey procedure, and the issue
updates.

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.4 (pinned in `package.json`)

**Primary Dependencies**: `@agentclientprotocol/sdk` (runtime only, unchanged); no new dependency

**Storage**: hub SQLite (`bun:sqlite`), migrations 4 to 6 appended to `MIGRATIONS`

**Testing**: `bun test packages`; real child processes and the existing fake ACP agent (`packages/runtime/test/fake-agent.ts`)

**Target Platform**: Linux hub and node; the release evidence needs bubblewrap

**Project Type**: library-first workspace (runtime → node/hub → client → CLI/MCP)

**Performance Goals**: a permission answer reaches the harness within one node poll interval plus the lease round trip (about 2 s at the default 1.5 s poll)

**Constraints**: outbound-only node; protocol version stays 1; credentials and stderr never enter events; the node is designed for a 1 CPU / 2 GB host

**Scale/Scope**: one owner, a handful of nodes, tens of caller tokens

## Constitution Check

| Principle | Status |
|---|---|
| I. Execution, Not Orchestration | Pass. Permissions are named as a run concern in principle I. Lineage records only who started a run and bounds depth: no task graph, no scheduling. |
| II. Library First | Pass. `runtime` is unchanged: it already takes `onPermission` and `permissionTimeoutMs`. Logic lives in hub and node; CLI and MCP only call new client methods. |
| III. One Contract, Honest Differences | Pass. Answers use the runtime's `allow`/`deny` decision for every harness. A node that does not advertise `permissions.remote` is refused with `permission_unsupported`, not emulated. |
| IV. Fail Closed | Pass. Silence is still deny after the timeout; an unknown token or scope is refused; requests end as cancelled on node loss and are never replayed; token secrets are digested and never logged. |
| V. Bring Your Own Harness | Pass. No harness management. |
| VI. Proof Over Claims | Pass. Every new guarantee has a failure-boundary test; soak and journey results are recorded with host and version. |
| VII. Stay Small | Pass. One scope, one new command type, one table per entity, no dependency. Token digests use SHA-256 because tokens are 256-bit random values, so a slow KDF adds nothing (research R1). |

No violations. The re-check after design is unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/004-close-issue-gaps/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-api.md        # tokens, permissions, lineage routes and errors
│   └── node-protocol.md   # permission.answer command and capability
└── checklists/requirements.md
```

### Source Code (repository root)

```text
packages/protocol/src/index.ts   # CommandType + "permission.answer"; RunRequest.parentRunId;
                                 # PermissionRequestView, CallerTokenView; error codes
packages/hub/src/
├── schema.ts        # migrations 4 (caller_tokens), 5 (permission_requests), 6 (runs lineage)
├── tokens.ts        # NEW: issue, list, revoke, authenticate → { kind: "admin" | "runs" }
├── permissions.ts   # NEW: record from events, list, answer, expire, cancel on terminal
├── server.ts        # bearer → principal; route guard by scope; new routes; SSE revocation check
├── runs.ts          # parentRunId, depth, depth_exceeded, parent_not_found
├── events.ts        # appendEvents records permission.requested / permission.resolved
├── commands.ts      # enqueue with an explicit idempotency suffix for permission.answer;
│                    # cancel pending requests when a run ends
├── config.ts        # AGENTICFORM_RUN_MAX_DEPTH (default 3)
└── ui/              # pending-permission list with Allow / Deny on the run view
packages/node/src/
├── executor.ts      # onPermission handler keyed by toolCallId; handle permission.answer
├── poller.ts        # lease permission.answer as a control command (like run.cancel)
└── node.ts          # advertise capability permissions.remote
packages/client/src/index.ts     # tokens, permissions and parentRunId methods
packages/cli/bin/af.ts           # af token issue|list|revoke; af run permissions <id>; af run answer <id> <toolCallId> allow|deny; --parent on af run start
packages/mcp/bin/mcp.ts          # list_permissions, answer_permission; parentRunId on start_run
scripts/
├── soak.ts          # NEW: FR-018 runner, writes a JSON result
└── package-node.ts  # NEW: FR-020 build + size + start-time measurement
docs/release-evidence.md         # NEW: two-machine journey procedure and recorded results
```

Tests sit next to their packages: `packages/hub/test/tokens.test.ts`,
`packages/hub/test/permissions.test.ts`, additions to `runs.test.ts`,
`packages/node/test/permissions.test.ts`, and CLI and MCP cases in their existing
test files.

**Structure Decision**: two new hub modules (`tokens.ts`, `permissions.ts`) because
each owns a table and a failure mode, and `server.ts` is already the largest hub
file. The node needs no new module: a permission is one more control command.
Evidence scripts go in a top-level `scripts/` because they span packages and are
never imported.

## Design Notes

### Principal and route guard

`authenticateBearer` becomes `authenticate(config, db, headers): Principal`. The
admin token is compared first, unchanged. Any other token must have the form
`afc_<id>_<secret>`: the hub looks up `id`, compares the SHA-256 digest of the
whole token in constant time, and rejects a revoked row. A route table maps each
caller route to the scopes that may use it:

| Routes | admin | runs |
|---|---|---|
| `POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/cancel`, `GET /v1/nodes` | ✓ | ✓ |
| `POST /v1/runs/{id}/recover` | ✓ | ✗ |
| `GET /v1/runs/{id}/permissions` | ✓ | ✓ (read only) |
| `POST /v1/runs/{id}/permissions/{requestId}` | ✓ | ✗ |
| `POST /v1/enrollment-tokens`, `POST /v1/nodes/{id}/(disable|revoke)`, `/v1/tokens*` | ✓ | ✗ |

A route not in the table is admin-only, so a future route is closed by default.
A `runs` token on a refused route gets `403 forbidden`; a missing, unknown or
revoked token gets `401 unauthorized`, as today. `last_used_at` is written at most
once a minute per token, so reads do not turn into a write each.

The SSE loop re-checks the principal every keepalive (5 s) and ends the stream
with an `error` event `{ code: "unauthorized" }` once the token is revoked, which
meets the 30 s bound with margin.

### Permission flow

```text
harness ──session/request_permission──▶ runtime ──onPermission(req)──▶ node executor
node: emit permission.requested {toolCallId,title,kind} ──event batch──▶ hub
hub:  INSERT permission_requests (pending, expires_at = requested_at + timeout)
owner ──POST /v1/runs/{id}/permissions/{toolCallId} {decision}──▶ hub
hub:  UPDATE ... SET status='answered' WHERE status='pending'  (exactly one wins)
      enqueue permission.answer {toolCallId, decision} key run:{id}:permission.answer:{toolCallId}:{gen}
node ──lease (control lane)──▶ executor resolves the waiting promise ──▶ runtime ──▶ harness
runtime emits permission.resolved ──▶ hub marks the row resolved (or timed_out on "deny" after expiry)
```

- The node handler is a map `toolCallId → resolve`. An answer for an unknown or
  already-resolved id completes the command as `succeeded` with
  `{ applied: false }`, so a duplicate never reaches the harness twice (FR-009).
- The runtime's `permissionTimeoutMs` (300 s default) stays the only clock that
  denies. The hub stores `expires_at` from the same value and refuses answers
  after it with `permission_expired`, even before the resolving event arrives.
- A request id is the ACP `toolCallId`, which is unique within a session. The hub
  key is `(run_id, generation, tool_call_id)`, so a recovered run with a new
  generation can never receive an old answer.
- Run end (completed, failed, cancelled, disconnected, fenced generation) marks
  every pending row of that run `cancelled` in the same transaction as the status
  change.
- A node that does not advertise `permissions.remote` keeps today's behaviour:
  no handler, immediate deny. An answer for such a run is `409 permission_unsupported`.

### Lineage

`runs` gains `parent_run_id` and `depth`. On create, the hub loads the parent
(`parent_not_found` if absent), computes `depth = parent.depth + 1`, and refuses
`depth > maxDepth` with `422 depth_exceeded` before any insert. `parentRunId` is
part of the idempotency fingerprint, so the same key with a different parent is
an `idempotency_conflict`. The parent may be in any status.

### Evidence

- `scripts/soak.ts`: starts a hub and a node against the fake agent (or a real
  harness when `AGENTICFORM_SOAK_HARNESS` is set). It submits a mixed stream of
  runs (complete, cancel, permission allow, permission timeout), restarts the
  node on a schedule, samples `VmRSS` every 60 s, and at the end counts orphaned
  children (`pgrep -g` per recorded group) and non-terminal runs. It writes
  `soak-result.json` and exits non-zero on any failure (FR-018, SC-005).
- `scripts/package-node.ts`: builds the node with `bun build --compile` and as a
  plain `bun install --production` tree. It lists the contents, measures size and
  cold start to first heartbeat, and prints a decision table (FR-020).
- `docs/release-evidence.md`: the two-machine procedure (FR-019) as numbered
  steps, plus a results table that the person running it fills in with host, date,
  versions and pass or fail per step.

## Testing Strategy

- **Contract**: route-to-scope table (every route, both scopes, plus no token);
  permission state machine (pending → answered | timed_out | cancelled, nothing
  leaves a terminal state); lineage depth arithmetic and limit.
- **Failure boundaries**: revoked token mid-follow; concurrent double answer
  (exactly one 200); answer after expiry; answer naming a bad decision; answer
  for an old generation; node without `permissions.remote`; parent missing;
  depth + 1 over the limit; idempotent resubmit with a changed parent.
- **Real process**: node permission test runs the fake ACP agent, which asks
  permission, through a real hub and node, and asserts allow, deny and timeout
  reach the agent.
- **Secrets**: a token secret never appears in a response after issue, in events,
  in logs captured during tests, or in the UI bundle.
- **Unaffected**: `bun test packages` and `bun run typecheck` pass; protocol
  version stays 1.

## Complexity Tracking

No constitution exceptions.
