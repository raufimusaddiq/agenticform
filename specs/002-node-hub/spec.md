# Feature Specification: Node and Hub

**Feature Branch**: `002-node-hub`

**Created**: 2026-11-18

**Status**: Draft

**Input**: User description: "Remote execution: an outbound-only node daemon that runs the local `runtime`, and a hub that enrolls nodes, places runs, fences runtime identity, and exposes one HTTP API. Consume the invariants recorded in `docs/node-hub-invariants.md`."

## Scope

This feature adds the `node` and `hub` packages and the remote half of the HTTP
contract. It does not add the `client` SDK, CLI or MCP server; they are thin
clients of the same API in a later spec. It does not add orchestration,
projects, tasks, approvals, policy or messaging (constitution I).

The behaviour reference is `docs/node-hub-invariants.md` (T-2). Rules there are
binding inputs, not suggestions; requirement ids below map to them.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enroll a machine without opening a port (Priority: P1)

An operator installs the node on a machine and runs one enrollment command. The
node generates a device key, redeems a one-time token, stores its identity and
connects outbound. Nothing listens for inbound connections.

**Why this priority**: Without enrollment there is no remote surface, and
outbound-only is the promise that makes exposing a machine acceptable.

**Independent Test**: Start a fake hub on loopback, enroll a node, assert one
identity file with mode `0600`, a heartbeat arrives, and no socket on the node
accepts inbound connections.

**Acceptance Scenarios**:

1. **Given** a valid enrollment token, **When** the node enrolls, **Then** the hub stores the token hash, consumes the token once and records the node's Ed25519 public key.
2. **Given** a consumed or expired token, **When** enrollment is attempted, **Then** it fails with a named error and no node record is created.
3. **Given** a non-local `http://` hub URL, **When** the node starts, **Then** it refuses to start.
4. **Given** an enrolled node, **When** it runs, **Then** it only dials out and holds no listening socket.

---

### User Story 2 - Run a harness on a remote machine (Priority: P1)

A caller submits a run with a harness, working directory, prompt and optional
requirements. The hub places it on an eligible node, the node executes it with
`runtime`, and the caller follows ordered events and one final result.

**Why this priority**: This is the product: the same run API as local execution, on another machine.

**Independent Test**: With one fake node and a fake ACP agent, submit a run, read events to the terminal event, and assert the result matches a local run of the same input.

**Acceptance Scenarios**:

1. **Given** an online node advertising `codex`, **When** a run requires `codex` and `git`, **Then** the hub issues one command, the node executes it and the caller receives ordered events ending in exactly one terminal event.
2. **Given** no eligible node, **When** a run is submitted, **Then** it fails with `no_eligible_node` and no command is queued.
3. **Given** a node that does not advertise a required capability, **When** a run requires it, **Then** placement skips that node rather than degrading.
4. **Given** a caller re-submits the same idempotency key, **When** the hub already created that run, **Then** the same run id is returned and no second command exists.

---

### User Story 3 - Refuse stale and replayed work (Priority: P1)

A runtime that has moved on, or a request captured in transit, cannot mutate
state. Every identity is fenced and every request is single-use.

**Why this priority**: At-least-once delivery plus an unreliable network is only safe with fencing and idempotency.

**Independent Test**: Lease a command, advance the runtime generation, then complete the command; assert it is refused and no state changed. Replay a signed request verbatim; assert rejection.

**Acceptance Scenarios**:

1. **Given** a queued command, **When** the runtime generation advances before lease, **Then** the command is cancelled and never executed.
2. **Given** a completed command, **When** an older generation reports a snapshot, **Then** it is recorded as stale and does not replace current state.
3. **Given** a signed request, **When** it is replayed with the same nonce, **Then** it is rejected and the original effect is not repeated.
4. **Given** a request with a bad signature, **When** a correctly signed request reuses the same nonce, **Then** the second is accepted, proving the first did not burn the nonce.
5. **Given** a command whose payload generation differs from its envelope, **When** the node receives it, **Then** it refuses before any side effect.

---

### User Story 4 - Survive a node that dies mid-command (Priority: P2)

A node loses power between recording `STARTED` and reporting a result. On
restart it refuses to guess, reports the ambiguity visibly, and the hub marks the
run failed unless an operator recovers it.

**Why this priority**: Ambiguous effects must never be replayed automatically (constitution IV).

**Independent Test**: Kill the node process after `STARTED` is persisted, restart, re-deliver the same command, and assert a visible ambiguity error with no effect.

**Acceptance Scenarios**:

1. **Given** a `STARTED` ledger entry after restart, **When** the command is re-delivered, **Then** the node returns `ambiguous_replay` and does nothing.
2. **Given** a terminal ledger entry and a lost completion response, **When** the command is re-leased, **Then** the cached result is returned and the effect count stays one.
3. **Given** a node silent past the offline window, **When** the window elapses, **Then** the node is `OFFLINE` and its running runs are `DISCONNECTED`.

---

### User Story 5 - Recover a run onto another node (Priority: P3)

An operator, or an explicit opt-in rule, recovers a disconnected run onto another
eligible node under a new generation. Recovery restores logical state only.

**Why this priority**: Valuable but not needed for the first remote run; it must never be automatic on ambiguous effects.

**Independent Test**: With a disconnected run and a second eligible node, request recovery and assert generation N+1, a separate workspace, and no claim that uncommitted files survive.

**Acceptance Scenarios**:

1. **Given** a run `DISCONNECTED` on an `OFFLINE` node, **When** recovery is requested and every precondition holds, **Then** a new generation starts on an eligible node and the old generation is fenced out.
2. **Given** any missing precondition (no eligible node, pending approval, non-GIT workspace), **When** recovery is requested, **Then** it is refused with a named reason and the run stays disconnected.
3. **Given** a recovered run, **When** the old node reconnects with its stale generation, **Then** its observations are recorded as stale and cannot mutate state.

---

### Edge Cases

- The hub URL is non-local and not HTTPS: node refuses to start.
- The node's clock is outside the allowed skew: requests are rejected with a generic error.
- A nonce expires exactly at the boundary: it is not accepted for a new request.
- Two enrollment attempts race on one token: exactly one succeeds.
- The same idempotency key arrives with a different payload: rejected as a conflict, not silently reused.
- A completion arrives for a command that was never leased: refused.
- A duplicate identical success arrives: no-op returning the stored command. A differing duplicate: refused.
- A node advertises protocol version `0` or `2`: refused and never issued commands.
- A node's heartbeat carries a generation older than the hub's: recorded as stale.
- The hub restarts while a command is leased: lease expiry returns it to the queue, and fencing plus idempotency make redelivery safe.
- A node cannot reach the hub: it backs off and retries; it never claims the run succeeded.
- The node's ledger is corrupt or unreadable: the node refuses to execute anything for that command and reports a failure.
- A run's working directory is missing on the node: the run fails with `workspace_missing` before the harness starts.

## Requirements *(mandatory)*

### Functional Requirements

**Transport and identity**

- **FR-001**: The node MUST initiate every connection; it MUST NOT listen on any network socket. (N1.1)
- **FR-002**: The node MUST require HTTPS for any non-loopback hub URL and MUST refuse to start otherwise. (N1.1, N8.2)
- **FR-003**: The hub MUST expose exactly one HTTP API for nodes, callers and operators, versioned in the URL, with JSON bodies.
- **FR-004**: The node MUST pull work: heartbeat on an interval and poll for the next command, treating an empty poll as normal. (N1.2)
- **FR-005**: The hub and node MUST negotiate a protocol version and MUST fail closed on an unsupported one, refusing commands for that node. (N1.3)

**Enrollment and signatures**

- **FR-006**: The hub MUST authenticate machine endpoints with an Ed25519 signature over `nodeId`, `timestampMs`, `nonce`, upper-case method, exact path and the hex SHA-256 of the body, newline-separated. (N2.1)
- **FR-007**: The hub MUST verify in order: known node, node enabled, nonce shape, clock skew, signature, then nonce insert. (N2.2)
- **FR-008**: The hub MUST accept only Ed25519 node keys and MUST reject other algorithms and bad encodings with a named error. (N2.3)
- **FR-009**: The hub MUST consume a nonce only after a valid signature, atomically, and MUST reject a replay. (N3.1, N3.2)
- **FR-010**: The hub MUST delete expired nonces on a schedule and MUST NOT accept a nonce at or past expiry. (N3.3)
- **FR-011**: Enrollment tokens MUST be single-use, short-lived and stored only as a SHA-256 hash, consumed atomically under a lock. (N8.3)
- **FR-012**: The node MUST generate its key locally, store the private key with mode `0600`, send only the public key, and discard the enrollment token. (N8.3)
- **FR-013**: Authentication failures on machine endpoints MUST return generic errors that do not disclose node existence or signature details. (N8.4)
- **FR-014**: The caller and operator API MUST require `Authorization: Bearer <token>`, compared in constant time, with no anonymous fallback. (N8.1)
- **FR-015**: The hub MUST refuse to start with a missing or short admin token, or with a non-local non-HTTPS public URL that is not a clean origin. (N8.2)

**Placement and runs**

- **FR-016**: The hub MUST place a run only on an online, enabled node whose protocol version, advertised harnesses and required capabilities satisfy the request. (N1.3)
- **FR-017**: The hub MUST fail a run with `no_eligible_node` without queueing a command when no node qualifies.
- **FR-018**: The hub MUST identify runs and commands with its own ids, never ids issued by a harness.
- **FR-019**: The node MUST execute accepted commands through the `runtime` package and MUST NOT implement harness logic itself.
- **FR-020**: The hub MUST expose ordered, replayable run events with monotonically increasing sequence numbers, ending in exactly one terminal event.
- **FR-021**: The node MUST reject a command whose signed payload generation differs from the envelope generation, before any side effect. (N4.3)

**Fencing**

- **FR-022**: Every runtime MUST have a monotonically increasing generation; a command, event batch, snapshot or credential request is valid only if its identity matches current state. (N4.1)
- **FR-023**: The hub MUST check fencing at enqueue, at lease and at completion; a stale command is cancelled, never executed. (N4.2)
- **FR-024**: The node MUST keep runtime state monotonic and MUST NOT replace current state with an older generation. (N4.3, N4.4)
- **FR-025**: Moving a generation to another node MUST be treated as fencing, not migration.

**Idempotency and durability**

- **FR-026**: Command creation MUST be keyed by an idempotency key with a unique constraint; re-enqueue MUST return the existing command. A reused key with a different payload MUST be rejected. (N5.1)
- **FR-027**: Completion MUST be idempotent for identical terminal results and MUST reject conflicting duplicates and completions for a non-leased command. (N5.2)
- **FR-028**: The node MUST fingerprint commands as SHA-256 of type, idempotency key, generation and payload, and MUST refuse a reused command id with a different fingerprint. (N5.3)
- **FR-029**: The node MUST persist `STARTED` atomically (temp file, fsync, rename, mode `0600`) before executing a command. (N6.1)
- **FR-030**: The node MUST cache terminal results and return them on re-lease after a lost completion. (N6.2)
- **FR-031**: The node MUST refuse to replay an ambiguous `STARTED` command automatically and MUST report a visible failure. (N6.3)
- **FR-032**: The node MUST bound ledger growth, removing only terminal entries older than the retention window.

**Health and recovery**

- **FR-033**: The hub MUST mark a node `OFFLINE` after the heartbeat window and mark its running runs `DISCONNECTED`. (N7.1)
- **FR-034**: Recovery MUST be explicit and fail closed on every precondition: run disconnected, node offline, grace elapsed, GIT-backed workspace, no pending approval, another eligible node. (N7.2)
- **FR-035**: Recovery MUST issue a new generation and a separate workspace, and MUST NOT dispatch work before the replacement runtime exists. (N7.3)
- **FR-036**: Recovery MUST restore logical state only and MUST NOT describe itself as live migration. (N7.4)
- **FR-037**: A reconnecting node's pre-recovery observations MUST be recorded as stale, and a restarted node MUST advertise an empty runtime inventory. (N7.5)

### Key Entities

- **Node**: An enrolled machine: id, public key, status, protocol version, runtime inventory, last heartbeat.
- **EnrollmentToken**: One-time secret stored as a hash with an expiry and single consumption.
- **RequestNonce**: Consumed `(nodeId, nonce)` pair with an expiry, deleted on schedule.
- **Run**: One remote execution: harness, working directory, prompt, requirements, status, terminal result.
- **RuntimeAssignment**: The fence: node, run, generation, runtime type and session id.
- **Command**: One leased unit of work: type, idempotency key, generation, payload, status, terminal result.
- **RunEvent**: One ordered, normalised event in a run's stream.
- **LedgerEntry**: The node's durable `STARTED`/`SUCCEEDED`/`FAILED` record for a command.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A remote run of the same input produces the same terminal result and event type sequence as a local run.
- **SC-002**: Every failure in the edge-case list produces a named error code and, for a run, a terminal event.
- **SC-003**: No tested node opens an inbound socket, and no tested node accepts a non-local plain-HTTP hub URL.
- **SC-004**: Every replay, duplicate and stale-generation case in the invariant tests is refused without a state change.
- **SC-005**: A node killed between `STARTED` and completion never executes that command twice.

## Assumptions

- One hub per deployment; its durable store is embedded and local. Multi-hub replication is out of scope.
- Nodes have stable disk for identity and the ledger, and may restart at any time.
- Harnesses are installed and authenticated on the node by its owner (constitution V).
- Workspaces on a node are GIT-backed when recovery is expected to work.
- The Java, Go and React code stays untouched; the legacy stack is a behaviour reference only.
- No harness credentials, prompts or stderr enter hub storage; harness stderr stays out of events for the same reason it does locally.
