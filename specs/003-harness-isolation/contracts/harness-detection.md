# Contract: Harness Detection

How the node decides whether a harness is usable, what it reports, and what a run
gets when it is not. Consumes `docs/harnesses.md` and the `runtime` error codes.

## 1. Status

```ts
type HarnessStatus = "ready" | "missing" | "unauthenticated" | "unknown"

type HarnessReport = {
  id: string
  status: HarnessStatus
  reason?: string
  probedAt: string        // ISO 8601, node clock
}
```

`ready` is the only status that may be advertised for placement.

## 2. Probe

A probe has two steps and stops at the first failure.

### 2.1 Resolve without network

| Entry point | Ready to probe when |
|---|---|
| direct command (`opencode`, `omp`, `dsh`, `hermes`, `openclaw`) | the command resolves on the node's `PATH` |
| `bunx <pkg>@<version>` (`claude`, `codex`, `pi`) | the pinned package and version exist in the local Bun install cache |

The probe MUST NOT run a package manager in a mode that can download. A missing
cache entry is `missing` with reason `version_not_cached`, even if the network is
available.

### 2.2 Handshake inside the sandbox

Spawn the harness through the isolation contract, perform ACP `initialize` only,
then close. No session, no prompt, no tool call, no permission request.

| Observation | Status | Reason |
|---|---|---|
| not resolvable | `missing` | `not_installed` |
| pinned version not cached | `missing` | `version_not_cached` |
| spawn fails | `missing` | `spawn_failed` |
| ACP error `auth_required` | `unauthenticated` | `auth_required` |
| handshake completes | `ready` | — |
| timeout after 20 s | `unknown` | `handshake_timeout` |
| process exits before handshake | `unknown` | `process_exited` |
| protocol or other runtime error | `unknown` | the runtime error code |

The probe reads no credential file and sends no prompt. Its stderr is discarded.

## 3. Cache

- TTL 300 s per harness.
- One probe at a time; a probe in flight is not duplicated.
- A failed run invalidates that harness's entry, so the next heartbeat re-probes.
- A probe never blocks a heartbeat: the heartbeat reports the last known status
  and the probe result lands on a later beat.
- The cache is in memory; a restart re-probes.

## 4. Heartbeat

Existing fields keep their meaning. Two optional fields are added; a version-1
hub ignores them.

```ts
type HeartbeatRequest = {
  protocolVersion: number
  status?: string
  harnesses: string[]                 // ready ids only, as today
  capabilities?: string[]
  capacity?: { slots: number; inUse: number }
  runtimes?: RuntimeInventoryEntry[]
  harnessReport?: HarnessReport[]     // every configured harness
  isolation?: {
    mode: "bwrap" | "sandbox-exec" | "none"
    profile: string                   // profile version, e.g. "1"
    selfTest: "pass" | "fail"
  }
}
```

Rules:

- `harnesses` MUST equal the ids whose status is `ready`.
- `harnessReport` MUST include every harness the node is configured to offer,
  including `missing` and `unauthenticated` ones.
- `isolation.mode: "none"` implies `harnesses: []`.
- No raw harness output, path or credential appears in either field.

## 5. Run failure

| Requested harness status | Run result | Child spawned |
|---|---|---|
| `ready` | normal run | yes |
| `missing` | `harness_missing` | no |
| `unauthenticated` | `harness_unauthenticated` | no |
| `unknown` | `harness_unavailable` | no |
| not configured on this node | `harness_missing` | no |

The error is terminal: it is not retried automatically, and the run's terminal
event carries the code and a message naming the harness. The message MUST NOT
include harness stderr.

## 6. Placement

The hub places only on advertised harnesses, unchanged from 002. When no node
qualifies, `no_eligible_node` names the requested harness and, when a node
reported it, the best-known status:

```json
{ "error": { "code": "no_eligible_node", "message": "no node satisfies codex: unauthenticated on node 6f1c2a9e" } }
```

No new placement error code and no protocol version bump.

## 7. Operator view

`GET /v1/nodes/{id}` returns the last heartbeat's `harnessReport` and `isolation`
verbatim, so an operator can see why a harness is not placed. The node's own
`agenticform-node status` prints the same table locally.