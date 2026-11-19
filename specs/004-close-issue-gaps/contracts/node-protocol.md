# Contract: Node protocol additions

These extend `specs/002-node-hub/contracts/node-protocol.md`. The protocol version
stays 1.

## 1. Capability

A node that implements this contract adds `permissions.remote` to its heartbeat
`capabilities`. The hub must not enqueue `permission.answer` for a node that does
not advertise it.

## 2. Waiting for an answer

When a hub-placed run starts on a node with `permissions.remote`, the node passes
`runtime.run` an `onPermission` handler. For each request, the handler:

1. registers a waiter keyed by `toolCallId` for that run and generation;
2. returns a promise that settles with the decision from `permission.answer`.

The runtime's `permissionTimeoutMs` (default 300 s) denies first when no answer
arrives. When the run ends, every waiter is dropped. The node never stores a
waiter on disk.

The runtime already emits `permission.requested` and `permission.resolved`, and
the node forwards them unchanged through the event batch.

## 3. `permission.answer` command

```ts
type CommandType = "run.start" | "run.cancel" | "run.inspect" | "permission.answer"

// payload
{ toolCallId: string; decision: "allow" | "deny"; generation: number; fingerprint: string }
```

- The poller leases it in the control lane, so it is never blocked by full
  `run.start` slots.
- It is fenced and fingerprinted like other commands, and the ledger admits each
  command id once.
- When a waiter exists, the node resolves it and completes with
  `{ status: "succeeded", result: { applied: true } }`.
- When none exists (already timed out, run ended, unknown id), the node completes
  with `{ status: "succeeded", result: { applied: false } }`. That is not an error,
  and the harness is not told twice.
- A stale generation is `fence_stale`, as for every command.
- A `permission.answer` completion never changes the run's status, the same rule
  as `run.inspect`.
