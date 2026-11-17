# Contract: Node Protocol

The wire rules a node and hub must agree on, independent of HTTP routing. This
contract consumes `docs/node-hub-invariants.md` sections 2-6.

## 1. Signed request envelope

Every post-enrollment node request carries:

```text
X-AF-Node-Id: 6f1c2a9e-...
X-AF-Timestamp: 1763553600000
X-AF-Nonce: 9f2c1a7be4d80612
X-AF-Signature: <base64 Ed25519 signature>
```

- `nodeId` is the hub-issued id the signature covers; it is sent in `X-AF-Node-Id`.

- `timestamp` is Unix milliseconds.
- `nonce` matches `[A-Za-z0-9._:-]{16,128}`, generated from 128 random bits.
- `signature` is base64 over the UTF-8 canonical string below.
- The path is the exact request path, excluding scheme and host, including the
  `v1` prefix and any query string.

### Canonical string

```text
nodeId + "\n" + timestampMs + "\n" + nonce + "\n" + METHOD + "\n" + path + "\n" + hexSha256(rawBody)
```

`METHOD` is upper-case. `hexSha256` is lower-case hex of the raw body bytes;
an empty body hashes the empty byte array, not `""`.

### Verification order

The hub checks, in this order, and stops at the first failure:

1. node id exists and is not `REVOKED` or `DISABLED`;
2. nonce shape;
3. timestamp within ±2 min (configurable);
4. Ed25519 signature over the canonical string with the stored public key;
5. insert `(nodeId, nonce)`; anything but one affected row is a replay.

Steps 1-4 never consume the nonce. Any failure returns the same generic
`401 unauthorized`, so a caller cannot tell whether the node or the signature was
wrong.

## 2. Identity and key format

- Node private key: Ed25519, PKCS#8 DER, stored at
  `$HOME/.agenticform-node/identity/device.pem`, mode `0600`.
- Public key: SPKI DER, base64 in requests and at rest.
- Only Ed25519 is accepted. Any other algorithm or a malformed encoding fails
  enrollment, and a stored key that cannot decode fails verification with a
  named internal error, never a bypass.
- A node id is a hub-issued UUID and is permanent until revoked.

## 3. Version negotiation

- `protocolVersion` is an integer; supported range is `1..1`.
- The node includes its version in enrollment and every heartbeat.
- The hub accepts a heartbeat with a supported version, and refuses to enqueue or
  lease commands for an incompatible node (`409 version_unsupported`).
- A node that receives a response for an unsupported version fails closed; it
  does not retry with a lower version.

## 4. Command shape and fingerprint

```ts
type Command = {
  commandId: string
  type: "run.start" | "run.cancel" | "run.inspect"
  runId: string
  generation: number
  idempotencyKey: string
  leasedUntil: string
  payload: unknown
}
```

The node computes:

```text
fingerprint = "sha256:" + hex(SHA-256(framed(type) + framed(idempotencyKey) + framed(generation) + framed(payloadJson)))
framed(part)  = decimal(UTF-8 byte length of part) + ":" + part
```

Length-prefixing keeps concatenation unambiguous. `JSON.stringify` uses the exact
bytes received, before any parsing round-trip, so the hub must send the fingerprint
of the body it transmitted. A reused `commandId` with a different fingerprint is
refused (`409 ambiguous_replay`), with no side effect.

## 5. Generation fencing

`(nodeId, runId, generation, runtimeType, runtimeSessionId)` identifies a runtime
assignment. The rules:

- the hub stamps the run's current generation at enqueue;
- at lease, a command whose `generation` differs from the run's current value is
  cancelled and never returned;
- at completion, a stale generation is cancelled and its result is not applied;
- the node refuses a command whose payload generation differs from the envelope
  generation, before any side effect;
- the node never replaces runtime state with a lower generation, and records any
  lower-generation observation as stale;
- an assignment moving to another node bumps the generation. That is fencing,
  not migration, and no process or filesystem state crosses nodes.

The hub's lease update is guarded by both `status = 'queued'` and the generation,
so two hubs or two workers cannot both win.

## 6. Idempotency

- **Create**: `commands(run_id, idempotency_key)` is unique. A repeat with the
  same payload returns the existing command. A repeat with a different payload is
  `409 idempotency_conflict`.
- **Complete**: identical terminal result is a no-op returning the stored command.
  A differing result, a second failure with a different error, or a completion
  for a non-leased command is `409`.
- **Events**: `(run_id, key)` is unique. Re-sending a batch is a no-op for the
  events the hub already has.
- **At-least-once execution**: command delivery may repeat. The node's ledger,
  not the transport, makes effects effectively-once.

## 7. Node ledger

State file: `$HOME/.agenticform-node/ledger/<commandId>.json`.

```json
{
  "commandId": "uuid",
  "fingerprint": "sha256:...",
  "status": "started | succeeded | failed",
  "result": { "status": "completed" },
  "error": { "code": "process_exited", "message": "..." },
  "updatedAt": "2026-11-18T12:00:00.000Z"
}
```

Rules:

1. `started` is persisted atomically before the effect runs; the write is a temp
   file in the same directory, `fsync`, `rename`, mode `0600`.
2. A terminal state replaces `started` with the cached result.
3. On restart, `started` is ambiguous: refuse to replay, return
   `409 ambiguous_replay`, and surface a visible failure. Prefer a blocker over a
   second effect.
4. Compact terminal entries older than the retention window. Never remove
   `started`.
5. An unreadable or corrupt entry is treated as ambiguous, not as absent.

## 8. Node restart

- The node re-enrolls nothing; identity is reused.
- It never advertises runtimes or sessions from a previous process.
- In-flight leases from the prior process are left to expire, then the hub
  re-queues the command; fencing and the ledger make redelivery safe.
- The node never claims a run succeeded because it lost connectivity.
