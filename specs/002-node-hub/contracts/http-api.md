# Contract: HTTP API

One API, URL-versioned `v1`, JSON bodies, `application/json`. HTTPS except for
loopback. Two authentication modes, never mixed on one route:

- **machine**: `X-AF-Timestamp`, `X-AF-Nonce`, `X-AF-Signature` (see [node-protocol.md](node-protocol.md));
- **bearer**: `Authorization: Bearer <token>`, constant-time compare.

## Errors

```json
{ "error": { "code": "no_eligible_node", "message": "no node satisfies codex + git" } }
```

Machine authentication failures always use `401` with
`{"error":{"code":"unauthorized","message":"unauthorized"}}`, whatever failed.

| Code | HTTP |
|---|---|
| `invalid_input` | 400 |
| `unauthorized` | 401 |
| `payload_too_large` | 413 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `version_unsupported` | 409 |
| `idempotency_conflict` | 409 |
| `fence_stale` | 409 |
| `events_pending` | 409 |
| `nonce_replayed` | 409 |
| `lease_not_held` | 409 |
| `ambiguous_replay` | 409 |
| `capability_missing` | 422 |
| `no_eligible_node` | 422 |
| `recovery_precondition_failed` | 422 |
| `workspace_missing` | 422 |
| `internal` | 500 |

`nonce_replayed` is reserved and is not emitted on the wire: a replayed nonce is a
machine authentication failure and returns the generic `401 unauthorized` above
(see [node-protocol.md](node-protocol.md) and N8.4).

## Machine endpoints

### `POST /v1/enroll`

Unauthenticated; the body carries the one-time token.

```json
{
  "token": "af_enroll_...",
  "name": "builder-1",
  "publicKey": "<SPKI base64>",
  "protocolVersion": 1,
  "harnesses": ["codex", "opencode"],
  "labels": { "os": "linux", "arch": "x64" }
}
```

`201` → `{ "nodeId": "uuid", "protocolVersion": 1, "heartbeatSeconds": 15 }`.
Only the public key is sent; the hub stores the token hash and consumes it once.
Reuse, expiry and races return `401 unauthorized`.

### `POST /v1/node/heartbeat` (signed)

```json
{
  "protocolVersion": 1,
  "status": "online",
  "harnesses": ["codex"],
  "capacity": { "slots": 1, "inUse": 0 },
  "runtimes": [
    { "runId": "uuid", "generation": 3, "runtimeType": "codex", "runtimeSessionId": "ses_...", "state": "running" }
  ]
}
```

`200` → `{ "status": "online", "commandsPollMs": 1500 }`.
The inventory is process-local: a restarted node sends an empty `runtimes` list
(N7.5). A runtime with a generation older than the hub's is recorded as stale and
ignored.

### `GET /v1/node/commands/next` (signed)

`200` → one command; `204` → nothing queued, not an error.

```json
{
  "commandId": "uuid",
  "type": "run.start",
  "runId": "uuid",
  "generation": 3,
  "idempotencyKey": "run:uuid:3",
  "leasedUntil": "2026-11-18T12:15:00.000Z",
  "payload": {
    "fingerprint": "sha256:...",
    "harness": "codex",
    "cwd": "run/uuid",
    "prompt": "fix failing tests",
    "requires": ["mcp.http"],
    "mcpServers": []
  }
}
```

`payload.fingerprint` is the node's own fingerprint recomputed over
`type + idempotencyKey + generation + payloadJson`; a mismatch is refused (N5.3).

### `POST /v1/node/commands/{commandId}/renew` (signed)

Extends the lease. `200` → `{ "leasedUntil": "..." }`. `409 lease_not_held` if the
lease expired, the command was cancelled, or the generation advanced.

### `POST /v1/node/commands/{commandId}/events` (signed)

Append-only batch. Each event carries a node-scoped `key`, so retries do not
duplicate.

```json
{
  "events": [
    { "key": "c1:7", "type": "message.delta", "at": "2026-11-18T12:00:01.000Z", "data": { "text": "ok" } }
  ]
}
```

`200` → `{ "accepted": 1, "lastSeq": 42 }`. Hub assigns `seq` in one transaction.
Unknown or missing run/lease returns `409 fence_stale`.

### `POST /v1/node/commands/{commandId}/complete` (signed)

```json
{
  "status": "succeeded",
  "result": { "status": "completed", "output": "..." },
  "eventsToSeq": 47
}
```

or `{ "status": "failed", "error": { "code": "process_exited", "message": "..." } }`.

`200` → stored command. Duplicate identical result → `200`, no state change.
Differing duplicate or completion for a non-leased command → `409`. If
`eventsToSeq` is greater than the hub's last stored `seq`, completion is refused
with `409 events_pending`; flush the remaining events and retry.
Hub writes the terminal `run.finished` event in the same transaction.

## Caller and operator endpoints

### `POST /v1/runs`

```json
{
  "idempotencyKey": "job-42",
  "harness": "codex",
  "prompt": "fix failing tests",
  "cwd": "run/abc",                 // optional; hub assigns when absent
  "requires": ["mcp.http"],         // optional
  "mcpServers": [],                 // optional
  "nodeId": "uuid",                 // optional pin; otherwise placement chooses
  "labels": { "gpu": "false" }      // optional placement filter
}
```

`201` → a run object. Same key and same payload → `200` with the existing run.
Same key and different payload → `409 idempotency_conflict`. No eligible node →
`422 no_eligible_node` with no command row.

```json
{
  "runId": "uuid",
  "status": "queued",
  "nodeId": "uuid",
  "generation": 1,
  "createdAt": "2026-11-18T12:00:00.000Z"
}
```

Run status: `queued`, `leased`, `running`, `completed`, `failed`, `cancelled`,
`disconnected`.

### `GET /v1/runs/{runId}`

`200` → the run object, its terminal result or error, and `lastSeq`.

### `GET /v1/runs/{runId}/events?after=<seq>&stream=sse`

Without `stream`: JSON `{ "events": [...], "lastSeq": 42 }`, replayable from
`after`. With `stream=sse`: `text/event-stream`, `id:` is `seq`, reconnects with
`Last-Event-ID`. The stream ends after the terminal event. Late consumers get the
full sequence from `after=0`.

### `POST /v1/runs/{runId}/cancel`

Queues `run.cancel` fenced to the current generation. `202`. If the run is
already terminal or the node is offline, it returns `200` with the run unchanged
or marked `cancelled` when the runtime cannot be reached.

### `POST /v1/runs/{runId}/recover`

Explicit recovery. Every precondition in FR-034 must hold, or the response is
`422 recovery_precondition_failed` naming the missing one. On success the run
keeps its id, gets generation `N+1`, and starts on a new node with a new
workspace. Never automatic on a `STARTED`/ambiguous ledger entry.

### Nodes and tokens

| Route | Purpose |
|---|---|
| `GET /v1/nodes` | list nodes with status, inventory, last heartbeat |
| `POST /v1/nodes/{nodeId}/disable` | stop leasing; keep identity |
| `POST /v1/nodes/{nodeId}/revoke` | terminal; identity can never authenticate again |
| `POST /v1/enrollment-tokens` | create a token; returns the secret once |
| `GET /health` | unauthenticated liveness only |

`POST /v1/enrollment-tokens` → `201 { "token": "af_enroll_...", "expiresAt": "..." }`.
The secret is shown once and stored only as a SHA-256 hash.

## Terminal states

| Run status | Meaning |
|---|---|
| `completed` | the last turn ended with `end_turn` |
| `failed` | terminal error, `error.code` set |
| `cancelled` | caller cancelled, or the node reported cancellation |
| `disconnected` | the node went offline mid-run; recovery may follow |

Exactly one terminal event per run: `run.finished` with `status` equal to the run status.
