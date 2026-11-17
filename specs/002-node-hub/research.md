# Research: Node and Hub

Checked on 2026-11-18. This is a design record, not a claim about shipped code.
The binding behaviour comes from `docs/node-hub-invariants.md`; this file records
the choices the plan makes to satisfy it with the smallest surface.

## Decisions

| Area | Decision | Rejected alternative |
|---|---|---|
| HTTP server | `Bun.serve` with a small router | Hono or Express: a dependency for routing a dozen paths |
| HTTP client | built-in `fetch` with an abort timeout | an HTTP library: `fetch` covers signed requests and SSE |
| Signatures | WebCrypto Ed25519 (`crypto.subtle`), canonical string from N2.1 verbatim | a signing library: the canonical string and algorithm are already fixed |
| Hub storage | `bun:sqlite`, WAL, one writer, migrations as SQL strings | Postgres: an external service for one hub (constitution VII) |
| Node storage | files under `$HOME/.agenticform-node`, atomic `0600` writes | an embedded DB on the node: the ledger is small and append-oriented |
| Event delivery | SSE with `Last-Event-ID` replay, plus `?after=` polling | WebSocket: one more protocol for one direction |
| Node work loop | one in-flight command per runtime, bounded by a lease | a worker pool: no second real user yet |
| Placement | filter eligible nodes, then pick the least-loaded | scoring, bin packing, cost models: not needed for one to a few nodes |
| Wire encoding | JSON bodies, `application/json` | protobuf: unreadable in `curl` and larger to build |

## Numbers carried from the legacy stack

`AgenticformProperties.Node` and `application.yml` are the anchors. Values stay
configurable; defaults match so behaviour does not drift silently.

| Setting | Default |
|---|---|
| Heartbeat interval | 15 s |
| Empty-poll backoff | 1.5 s |
| Enrollment token TTL | 10 min |
| Request nonce TTL | 10 min |
| Nonce cleanup interval | 10 min |
| Max clock skew | ±2 min |
| Node offline after | 45 s |
| Command lease | 15 min |
| Recovery grace | 2 min |

## Transport and canonical signing

`nodeId` is a hub-issued UUID. The node signs the exact path from the request
line, including the API prefix and query string when present. Body hash is the
hex SHA-256 of the raw bytes, and empty bodies hash the empty byte string.

Canonical string, matching `NodeSignatureVerifier`:

```text
nodeId + "\n" + timestampMs + "\n" + nonce + "\n" + METHOD + "\n" + path + "\n" + hexSha256(body)
```

WebCrypto exports Ed25519 public keys as SPKI and signs raw bytes. The hub stores
the SPKI base64 that the node sent and rejects any other key type. Node identity
files are DER/PKCS#8, mode `0600`.

## Protocol version

Legacy accepts `heartbeat.protocolVersion` of `1..1`. The new contract uses the
same number, `1`, and a URL prefix `v1`; a version mismatch is a named error, not
a silent downgrade.

## Durable hub state

SQLite tables: `nodes`, `enrollment_tokens`, `request_nonces`, `runs`,
`runtime_assignments`, `commands`, `run_events`, `admin_token` (hash only, if
stored at all). Unique constraints do the safety work that code would otherwise
have to remember:

- `enrollment_tokens(token_hash)` unique, plus `consumed_at`;
- `request_nonces(node_id, nonce)` unique, `expires_at` indexed;
- `commands(run_id, idempotency_key)` unique;
- `commands(node_id, status, created_at)` for lease order;
- `run_events(run_id, seq)` unique, giving a total order per run.

Lease uses a single statement guarded by status and generation:

```sql
UPDATE commands SET status='leased', leased_until=?, lease_id=?
WHERE id=? AND status='queued' AND generation=?
```

An affected-row count other than 1 means someone else leased it or the fence moved.

## Node ledger

`ledger/<commandId>.json` holds `{ commandId, fingerprint, status, result?, error?, updatedAt }`.
Writes go to a temp file in the same directory, then `fsync`, `rename`, `0600`.
`STARTED` is written before the effect; terminal states replace it. Compaction
deletes terminal entries older than the retention window and never touches
`STARTED`.

## Open questions, resolved with defaults

- **Does the hub store harness credentials?** No. Credentials stay on the node
  (N8.3 and constitution IV). Resolved: never.
- **Does the node stream harness stdout?** No. It emits normalised `RunEvent`s;
  stderr stays out.
- **Is recovery automatic?** Off by default in the new stack. Legacy defaulted
  on; the new design makes it explicit because ambiguous replay is the larger
  risk. Configurable, but the precondition list is mandatory.
- **Where do run workspaces live?** Hub assigns a workspace id; the node creates
  it under its state directory. The caller never sends an absolute node path.

## Not researched further

MCP routing, message fabric, policy, projects and approvals are excluded by
constitution I and the invariants document. Multi-hub replication is deferred
until a second hub exists.
