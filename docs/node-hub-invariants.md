# node/hub invariants carried from the legacy stack

Behaviour reference only. Source: legacy Java control plane (`server/`) and Go node
(`node/`), pinned at commit `14a146450af4d497d310d6aedb602ae9942db960`.

The `server/`, `web/`, `node/` and `docs/legacy/` trees were removed from the
working tree after these invariants were ported; every path cited below resolves
at that commit, e.g. `git show 14a1464:node/cmd/agenticform-node/main.go`.

This file records the security and durability rules the future `node` and `hub`
packages must keep. It is an input to the Spec Kit *specify* step, not a design;
the resulting spec is [`specs/002-node-hub`](../specs/002-node-hub/spec.md).
Each rule names the legacy code that implements it and the focused test it implies
for the new packages. Tests target the contract or failure boundary, per
constitution VI; names are proposed, not required.

## 1. Node wire contract: outbound-only

**N1.1** A node dials the hub and never listens. No inbound port is published and
no harness/agent port is exposed. Transport is HTTPS except for loopback hosts.
Source: `node/cmd/agenticform-node/main.go:315-430` (heartbeat + poll loop),
`node/cmd/agenticform-node/main.go:1298` (`requireSecureServerURL`),
`docs/legacy/distributed-agent-fabric.md` ("Security model").
*Implied test:* start a fake hub on a loopback listener; assert the node opens no
listening socket, completes enrollment by outbound call only, and rejects a
non-local `http://` server URL.

**N1.2** Work is pulled, not pushed: the node heartbeats on an interval (15 s) and
polls `GET /api/nodes/{id}/commands/next` (1.5 s after `204`). The hub cannot open
a connection to the node.
Source: `main.go:315-330`, `main.go:378-430`.
*Implied test:* hub sends nothing unsolicited; a queued command appears only after
the node polls, and a `204` poll is not an error.

**N1.3** Protocol version is negotiated and incompatible peers fail closed. The hub
accepts `heartbeat.protocolVersion > 0`, requires a supported range (currently
1..1), refuses command enqueue for an incompatible node, and stops leasing to it.
Source: `server/src/main/java/com/agenticform/node/ExecutionNodeProtocol.java`,
`ExecutionNodeController.java:55`, `ExecutionNodeService.java:286-310`.
*Implied test:* a node declaring version `0` or `2` gets no commands and an
enqueue attempt fails with a named error.

## 2. Signed requests

**N2.1** Every post-enrollment node request carries `X-AF-Timestamp`,
`X-AF-Nonce` and `X-AF-Signature`. The Ed25519 signature covers, newline-separated,
`nodeId`, `timestampMs`, `nonce`, upper-case method, exact path, and the hex
SHA-256 of the body. Signer and verifier build the same canonical string.
Source: `node/cmd/agenticform-node/main.go:1113-1137`;
`server/src/main/java/com/agenticform/node/NodeSignatureVerifier.java:57-70`.
*Implied test:* signing the same canonical bytes round-trips; changing body, path,
method, timestamp or nonce in transit makes verification fail.

**N2.2** Verification order is: known node, node not `REVOKED`/`DISABLED`, nonce
shape (`[A-Za-z0-9._:-]{16,128}`), timestamp within the allowed clock skew,
signature, then nonce insert. Authorization checks precede nonce consumption.
Source: `NodeSignatureVerifier.java:34-79`.
*Implied test:* a signature made with another node's key, or a timestamp outside
the skew window, is rejected; the node is not told whether the node or the
signature failed.

**N2.3** Only Ed25519 keys are accepted for node identity; other algorithms and bad
encodings are rejected.
Source: `NodeSignatureVerifier.java:95-110`.
*Implied test:* enrolling or verifying with a non-Ed25519 SPKI key fails with a
named error.

## 3. Single-use nonces

**N3.1** A nonce is consumed only after the signature is valid. Insert is
`INSERT ... ON CONFLICT (node_id, nonce) DO NOTHING`; an affected-row count other
than 1 means replay and is rejected.
Source: `server/src/main/java/com/agenticform/node/NodeRequestNonceRepository.java:14-23`,
`NodeSignatureVerifier.java:73-79`.
*Implied test:* a valid request consumes its nonce; replaying the identical request
is rejected.

**N3.2** An invalid signature must not consume the nonce. The same nonce can be
used by a subsequent correctly signed request.
Source: `NodeSignatureVerifier.java` (insert happens after `verify`).
*Implied test:* send a bad signature, then a good signature with the same nonce —
the second request is accepted, proving the first did not burn the nonce. (Legacy
anchor: `NodeSignatureVerifierTest.rejectsInvalidSignatureBeforeNonceConsumption`.)

**N3.3** Expired nonce rows are removed on a schedule, so replay protection does not
grow without bound. TTL and cleanup interval are configurable.
Source: `server/src/main/java/com/agenticform/node/NodeRequestNonceCleanup.java:17`,
`NodeSignatureVerifier.java:74`.
*Implied test:* a nonce row past `expires_at` is deleted by cleanup; a nonce at
exactly the expiry boundary is not accepted for a new request.

## 4. Generation and session fencing

**N4.1** Each logical agent runtime has a monotonically increasing
`runtimeGeneration`. A node command, notification, credential request, completion
or runtime snapshot is valid only if its `(nodeId, runtimeGeneration, runtimeType,
runtimeSessionId)` matches current state.
Source: `docs/legacy/recovery.md` ("Runtime generation fencing");
`server/src/main/java/com/agenticform/agent/AgentEntity.java:216-227`
(`ownsRuntime`, `ownsRuntimeAssignment`).
*Implied test:* a command/snapshot/credential request carrying an older generation
is refused and cannot mutate agent, task or message state.

**N4.2** Fencing is checked at enqueue, at lease and at completion. Enqueue stamps
the agent's current generation; lease cancels a command whose runtime has moved;
completion cancels and rejects a stale runtime instead of applying it.
Source: `ExecutionNodeService.java:281-312`, `:315-333`, `:348-383`;
`NodeCommandRepository.java:14-29` (row locks on lease/complete).
*Implied test:* queue a command, advance the generation, then lease — the command
is cancelled; complete after advancing the generation — rejected with no state
change. (Legacy anchor:
`ExecutionNodeRecoveryTest.staleRuntimeCompletionIsCancelledAndRejected`.)

**N4.3** The node also refuses a command whose signed payload generation differs
from the envelope generation, and keeps runtime state monotonic — a snapshot from
an older generation cannot replace the current runtime.
Source: `node/cmd/agenticform-node/main.go:487-495`;
`node/cmd/agenticform-node/main_test.go:204` (`TestRuntimeStateRejectsOlderGeneration`).
*Implied test:* mismatched generation in payload vs envelope fails before any side
effect; loading runtime state with a lower generation does not overwrite a higher one.

**N4.4** Moving a generation across nodes is fencing, not migration. The old node
reconnecting with a stale generation cannot mutate the new generation's state.
Source: `docs/legacy/recovery.md` ("Runtime generation fencing").
*Implied test:* two nodes claim the same agent's two generations; only the current
one is accepted.

## 5. Idempotency

**N5.1** Command creation is keyed by an `idempotencyKey` with a unique constraint;
re-enqueue returns the existing command rather than creating a second effect.
Source: `ExecutionNodeService.java:301-311`,
`NodeCommandRepository.java:14`.
*Implied test:* enqueue the same key twice with the same payload — one row, same
command id; re-enqueue after the node has completed it does not execute it again.

**N5.2** Command completion is idempotent for identical terminal results and
rejects conflicting duplicates. A second success must match the stored
`resultJson`; a second failure must match the stored error; otherwise the
completion is refused. A completion for a non-leased command is refused.
Source: `ExecutionNodeService.java:352-383`.
*Implied test:* duplicate identical success is a no-op returning the stored
command; a success-then-different-success (or success-then-failure) is rejected.
(Legacy anchors: `ExecutionNodeRecoveryTest.identicalSuccessfulCompletionIsIdempotent`,
`conflictingDuplicateCompletionIsRejected`.)

**N5.3** The node fingerprints each command as
`SHA-256(commandType + idempotencyKey + generation + payloadJson)` and refuses a
reused command id whose fingerprint differs.
Source: `node/cmd/agenticform-node/main.go:1257-1261`, `:435-447`.
*Implied test:* deliver the same command id with a changed payload — refused as
reuse, with no side effect.

## 6. Durable receipts

**N6.1** Before executing a command, the node persists a `STARTED` ledger entry
atomically (temp file, fsync, rename, mode `0600`). Delivery is at-least-once;
effects are made effectively-once by this ledger.
Source: `node/cmd/agenticform-node/main.go:433-485` (executeDurable),
`:1225-1255` (writeJSONAtomic); `docs/legacy/recovery.md` ("Execution-node command
effects").
*Implied test:* kill the node process between persist-`STARTED` and execute;
restart and re-deliver — no side effect runs twice.

**N6.2** Terminal results are cached as `SUCCEEDED` (with result JSON) or `FAILED`
(with error) and returned again when the same command is re-leased after a lost
completion response.
Source: `main.go:443-465`;
`node/cmd/agenticform-node/main_test.go:126` (`TestDurableCommandCachesTerminalFailure`).
*Implied test:* execute once, drop the completion response, re-lease — the node
returns the cached result and the effect count stays one.

**N6.3** A command found in `STARTED` after a restart is ambiguous. The node
refuses to replay it automatically and reports a visible failure; it prefers a
blocker over an uncertain double effect.
Source: `main.go:449-452`; `docs/legacy/recovery.md` ("Execution-node command
effects").
*Implied test:* seed a `STARTED` entry, re-deliver the command — the node returns
an ambiguity error and performs no effect. (Legacy anchor:
`main_test.go:161` `TestDurableCommandRefusesAmbiguousStartedReplay`.)

**N6.4** Ledger growth is bounded: entries older than the retention window are
removed only when terminal, never while `STARTED`.
Source: `main.go:1209-1219`.
*Implied test:* compaction drops old `SUCCEEDED`/`FAILED` entries and retains every
`STARTED` entry.

## 7. Node-loss recovery

**N7.1** A node missing heartbeats for the offline window becomes `OFFLINE`; its
non-terminal agents become `DISCONNECTED`, and a project signal is emitted.
Source: `server/src/main/java/com/agenticform/node/ExecutionNodeHealthMonitor.java:33-64`.
*Implied test:* stop heartbeats past the window — node is `OFFLINE`, its active
agents are `DISCONNECTED`, and one signal is recorded. (Legacy anchor:
`ExecutionNodeHealthMonitorTest.staleDrainingNodeBecomesOfflineDisconnectsAgentsAndEmitsProjectSignal`.)

**N7.2** Automatic rehydration is fail-closed and requires all of: agent remote and
`DISCONNECTED`; assigned node `OFFLINE`; grace elapsed; project GIT-backed; no
pending human approval; another eligible node with `codex` + `git` capacity.
Source: `docs/legacy/recovery.md` ("Node-loss rehydration").
*Implied test:* each missing condition blocks recovery; all present permits it.

**N7.3** Recovery issues a new generation and a separate recovery branch, and
re-dispatches an active durable task only after the replacement runtime exists.
Source: `docs/legacy/recovery.md` ("Node-loss rehydration").
*Implied test:* recovery creates generation N+1 and does not dispatch before the
runtime start succeeds; a failed start leaves the task blocked, never half-dispatched.

**N7.4** Recovery restores logical state, not process or filesystem state.
Uncommitted work that existed only on the lost node is unrecoverable; the system
does not call this live migration.
Source: `docs/legacy/recovery.md` ("Important recovery boundary").
*Implied test:* a task whose only record is a local worktree file is re-run from
the prompt, with no claim that the file survives.

**N7.5** A reconnecting old node's runtime observations are recorded as stale and
cannot replace or mutate the recovered runtime. Sessions are process-local: a
restarted daemon never advertises sessions from the prior process.
Source: `docs/legacy/recovery.md` ("Node restart reconciliation");
`node/cmd/agenticform-node/main.go:278-282`.
*Implied test:* after recovery, a heartbeat carrying the pre-recovery generation is
rejected as stale; a restarted node advertises an empty runtime inventory.

## 8. Bearer-token auth, fail closed

**N8.1** The admin API requires `Authorization: Bearer <token>`; the token is
compared in constant time and missing/incorrect credentials leave the request
unauthenticated. Nothing falls back to anonymous access.
Source: `server/src/main/java/com/agenticform/config/AdminBearerAuthenticationFilter.java:27-46`.
*Implied test:* no header and a wrong token are both denied; the correct token is
accepted; a token differing in one byte is denied.

**N8.2** Startup fails closed for unsafe configuration: the admin token is required
and at least 32 characters; a non-local public URL must be HTTPS; the public URL
must be a clean origin with no credentials, path, query or fragment.
Source: `server/src/main/java/com/agenticform/config/SecurityStartupValidator.java:24-48`.
*Implied test:* boot with a short/missing token or an `http://` non-local URL and
assert startup aborts rather than serving.

**N8.3** Enrollment tokens are single-use and short-lived: the hub stores only the
SHA-256 hash, consumes the token atomically under a row lock, and rejects reuse,
races and expiry. Enrollment sends only public keys; the node private key is stored
`0600` and the enrollment token is never kept by the daemon.
Source: `ExecutionNodeService.java:98-145`; `docs/legacy/distributed-agent-fabric.md`
("Node enrollment").
*Implied test:* enroll once succeeds; the same token again fails; an expired token
fails; the stored row contains a hash, not the token.

**N8.4** Machine-endpoint authentication failures return generic responses so node
existence and signature details are not disclosed.
Source: `docs/legacy/distributed-agent-fabric.md` ("Authentication failures").
*Implied test:* unknown node and bad signature produce indistinguishable
externally visible errors.

## Explicit exclusions

Out of core per constitution I (execution, not orchestration). None of these move
into `node` or `hub`:

- task, project and approval-board state machines (`server/.../task`, `.../project`,
  `.../approval`);
- operations, runbooks and incidents (`server/.../operation`);
- deterministic policy and preauthorization (`server/.../policy`);
- message fabric and agent-to-agent routing (`server/.../message`);
- orchestration, delivery stages and dependency graphs (`TaskDispatchOrchestration`,
  `TaskDependencyService`).

Also not carried over: memory baselines. Legacy `memoryMb` is reported as `nil`
(`node/cmd/agenticform-node/main.go:361`), so no number is inherited; measure Bun
against the host once `node`/`hub` exist (host is 1 CPU / 2 GB).

## Non-goals

- No code in this ticket; no Java or Go execution; no secrets or live data.
- `hub` placement policy, trust levels and rotation of admin credentials are
  mentioned only where they gate the invariants above.
