# Implementation Plan: Node and Hub

**Branch**: `002-node-hub` | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-node-hub/spec.md`

## Summary

Add `@agenticform/hub` and `@agenticform/node`, plus a small shared
`@agenticform/protocol` for the wire types and canonical signing helpers that
both ends must agree on. The hub serves one versioned HTTP API, stores durable
state in embedded SQLite, enrolls nodes with one-time tokens, places runs, fences
generations and enforces idempotency. The node is an outbound-only daemon that
pulls commands, executes them through `runtime`, and keeps a local ledger so
effects are effectively-once.

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.4; the node entry point avoids
Bun-only APIs so it also runs on Node 22+

**Primary Dependencies**: none beyond the workspace; `bun:sqlite` (built-in) for
the hub, `runtime` for execution

**Storage**: hub uses `bun:sqlite` with WAL; node uses files under
`$HOME/.agenticform-node`

**Testing**: `bun test` with a fake hub, a fake node and a fake ACP agent; real
child processes where process behaviour matters; temporary SQLite per test

**Target Platform**: Linux and macOS

**Project Type**: Library packages plus one server entry point

**Performance Goals**: a node heartbeat costs one small query; a run event batch
is written in one transaction; no target beyond a few nodes per hub

**Constraints**: outbound-only, fail closed, single hub, no harness credentials
on the hub, no new third-party dependencies

**Scale/Scope**: one hub, a handful of nodes, one in-flight command per node runtime

## Constitution Check

*GATE: checked before design and re-checked after contracts.*

| Principle | Result |
|---|---|
| I. Execution, Not Orchestration | Pass: placement only; no tasks, projects, approvals, policy or messaging. The exclusions list in the invariants is copied into the spec. |
| II. Library First | Pass: `runtime` stays usable alone; `node` adds transport and durability around it; HTTP is the only remote contract; no separate CLI logic. |
| III. One Contract, Honest Differences | Pass: harness capability requirements drive placement; an unmet requirement fails with `capability_missing`, never a fallback. |
| IV. Fail Closed | Pass: generic auth errors, nonce after signature, generation fencing at enqueue/lease/complete, ambiguous `STARTED` never replayed, no credentials in hub state. |
| V. Bring Your Own Harness | Pass: the node refuses a missing harness with a named error; it never installs or authenticates. |
| VI. Proof Over Claims | Pass: each contract failure boundary has a test; tests use real processes for poll, kill and restart. |
| VII. Stay Small | Pass: built-in HTTP, SQLite and WebCrypto; one shared protocol package because node and hub are two real users; no scheduling engine. |

No violations. No complexity table.

## Project Structure

### Documentation (this feature)

```text
specs/002-node-hub/
├── plan.md
├── spec.md
├── research.md
├── tasks.md
└── contracts/
    ├── http-api.md
    └── node-protocol.md
```

### Source Code (repository root)

```text
packages/protocol/
├── src/index.ts            # wire types
├── src/canonical.ts        # canonical string and command fingerprint
└── test/canonical.test.ts

packages/hub/
├── src/index.ts            # createHub() for embedding in tests
├── src/server.ts           # Bun.serve, router, auth switch
├── src/config.ts           # admin token, public URL, limits, startup checks
├── src/schema.ts           # SQL migrations, one writer
├── src/enrollment.ts       # token create, hash, atomic consume
├── src/signatures.ts       # envelope verification, nonce insert
├── src/nonces.ts           # scheduled cleanup
├── src/nodes.ts            # heartbeat, health window, inventory, disable/revoke
├── src/placement.ts        # eligibility filter, least-loaded pick
├── src/runs.ts             # create, get, cancel, recover
├── src/commands.ts         # enqueue, lease, renew, complete
├── src/events.ts           # append batch, replay, SSE
├── bin/hub.ts              # process entry point
└── test/*.test.ts

packages/node/
├── src/index.ts            # createNode() for embedding in tests
├── src/config.ts           # hub URL, HTTPS rule, state dir, intervals
├── src/identity.ts         # Ed25519 generate, load, 0600
├── src/client.ts           # signed fetch, backoff
├── src/heartbeat.ts        # interval loop, inventory
├── src/poller.ts           # poll, lease, renew
├── src/ledger.ts           # atomic writes, fingerprints, compaction
├── src/executor.ts         # run.start/cancel/inspect via runtime
├── src/events.ts           # normalise and batch run events
├── bin/node.ts             # daemon entry, enroll or load identity
└── test/*.test.ts
```

**Structure Decision**: three workspace packages. `protocol` is extracted because
node and hub both need the exact same canonical bytes and fingerprints; a mismatch
there is a security bug, so one implementation is safer than two copies. The hub
is the only package that depends on `bun:sqlite`.

## Design Notes

### Placement

Eligibility is a pure filter: status `online`, not disabled, protocol version
supported, harness advertised, every required capability advertised, capacity free,
and an optional explicit `nodeId` or label match. Among the remainder, pick the
node with the fewest in-flight runs, then the oldest heartbeat. This is a
deliberate ceiling: no scoring, no affinity, no preemption. Add them only when a
real deployment has more nodes than fit in one screen.

### Leases and redelivery

A lease is a status plus an expiry, renewed by the node while it works. Expired
leases return to `queued`. Because delivery is at-least-once, the node ledger is
the safety net; the hub never assumes a lease means the effect did not happen.

### Event ordering

The hub assigns `seq` inside the same transaction that inserts a batch, so
per-run order is total, and SSE replay is a `WHERE seq > ?` query. The node's
`key` deduplicates retries; it is never exposed to callers as the sequence.

### Recovery

Explicit only. The hub evaluates all preconditions before writing anything, then
bumps the generation and enqueues `run.start` with the recovered prompt and a new
workspace id. A failed replacement start leaves the run `disconnected`; it is
never half-dispatched.

## Testing Strategy

- **Contract**: canonical string vectors, fingerprint reuse, envelope order,
  generic auth errors, error codes and statuses.
- **Failure boundaries**: nonce replay, bad signature then good signature with
  the same nonce, expiry boundary, stale generation at each of enqueue/lease/
  complete, conflicting completion, ambiguous `STARTED`.
- **Process**: node killed between `STARTED` and completion, restart, re-lease;
  node opens no listening socket; a non-local `http://` URL refuses to start.
- **Health**: heartbeat window → `OFFLINE` and `DISCONNECTED`; stale reconnecting
  inventory ignored.
- **Unaffected**: `bun test packages` still passes for `runtime`.

## Complexity Tracking

No constitution exceptions.
