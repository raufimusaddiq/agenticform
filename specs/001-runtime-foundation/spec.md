# Feature Specification: Runtime Foundation

**Feature Branch**: `001-runtime-foundation`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "Seamless use of multiple harnesses and machines, packaged like a library that orchestrators, applications and agents can use. Target harnesses include Claude Code, Codex, OpenCode, Pi, omp, DeepSeek Harness, OpenClaw, Hermes and OpenBot."

## Scope

This feature delivers the local `runtime` package, the first layer of the execution fabric. Remote execution (`node`, `hub`), the remote `client`, CLI and MCP interfaces follow in later specs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a harness from code (Priority: P1)

A developer calls one API with a harness name, working directory and prompt, follows streamed events, and receives one final result.

**Why this priority**: This is the smallest useful product and the base for every other layer.

**Independent Test**: Run a fake ACP agent as a real child process and assert the event order and final result.

**Acceptance Scenarios**:

1. **Given** an installed harness, **When** a caller starts a run, **Then** the caller receives ordered events ending in exactly one terminal event.
2. **Given** two different harnesses, **When** the same call is made to each, **Then** the only required change is the harness name.
3. **Given** several consumers of one run, **When** each reads events, **Then** each sees the full sequence from the start.

---

### User Story 2 - Fail clearly on missing capabilities (Priority: P1)

A caller states what a run requires. The runtime refuses to start work when the harness cannot provide it.

**Why this priority**: Honest capability handling is what makes one API safe across uneven harnesses.

**Independent Test**: Use a fake agent that lacks a required capability and assert a named error with no prompt sent.

**Acceptance Scenarios**:

1. **Given** a run requiring a capability the agent lacks, **When** the run starts, **Then** it fails with `capability_missing`, naming the capability, before any prompt is sent.
2. **Given** an agent that needs authentication, **When** the session is created, **Then** the run fails with `auth_required`.
3. **Given** a caller, **When** it inspects a run, **Then** the negotiated capabilities and harness profile are available.

---

### User Story 3 - Control permissions and interruption (Priority: P2)

A caller decides on agent permission requests, and can cancel or redirect a running turn.

**Why this priority**: Unattended agents need bounded authority and a way to stop.

**Independent Test**: Use a fake agent that requests permission and one that runs until cancelled.

**Acceptance Scenarios**:

1. **Given** no permission handler, **When** the agent asks permission, **Then** the request is denied.
2. **Given** a handler that allows, **When** the agent asks, **Then** an allow option is selected and the decision appears in events.
3. **Given** a running turn, **When** the caller cancels, **Then** the run ends as `cancelled`.
4. **Given** a running turn, **When** the caller steers, **Then** the turn is cancelled, a new turn starts with the new prompt, and events mark the steer as emulated.

---

### User Story 4 - Prove harness support (Priority: P2)

A maintainer runs one conformance suite against any harness and gets a comparable result.

**Why this priority**: Harnesses and adapters change often, so claims need repeatable proof.

**Independent Test**: The suite passes against the fake agent; a real harness can be selected by an opt-in setting.

**Acceptance Scenarios**:

1. **Given** the fake agent, **When** the suite runs in ordinary tests, **Then** it needs no credentials or paid inference.
2. **Given** an opt-in real harness, **When** the suite runs, **Then** it reports the handshake and capability result for that harness.

### Edge Cases

- The child process exits during a turn: the run fails with `process_exited` and is not retried.
- The command cannot be started: the run fails with `spawn_failed`.
- A cancelled agent ignores cancellation: the process is stopped after a grace period.
- The handshake never completes: the run fails with `handshake_timeout`.
- The agent negotiates an unsupported protocol version: the run fails with `protocol_unsupported`.
- The permission handler throws or the agent offers no matching option: the request is denied or cancelled.
- The caller's signal aborts before the run starts: no process remains.
- An agent emits an unknown update: it is preserved as an `other` event and does not fail the run.
- Updates for another session id are ignored.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The runtime MUST expose one call that starts a run from a harness, absolute working directory and prompt.
- **FR-002**: The runtime MUST identify runs and turns with its own ids, not harness-issued ids.
- **FR-003**: Events MUST be ordered, sequence-numbered, replayable to late consumers, and end with exactly one terminal event.
- **FR-004**: The runtime MUST use ACP v1 and treat any other negotiated version as unsupported.
- **FR-005**: The runtime MUST expose negotiated capabilities; unknown capabilities count as absent.
- **FR-006**: The runtime MUST reject unmet requirements before sending a prompt.
- **FR-007**: The runtime MUST pass caller-provided MCP servers to the session, subject to transport capability.
- **FR-008**: The runtime MUST deny permission requests by default.
- **FR-009**: The runtime MUST support cancel and an emulated steer.
- **FR-010**: The runtime MUST never retry a prompt automatically.
- **FR-011**: The runtime MUST stop the child process when a run ends.
- **FR-012**: The runtime MUST NOT call `authenticate`, install harnesses, or manage their credentials.
- **FR-013**: The harness catalog MUST state profile, command and verification level for each entry, and callers MUST be able to supply custom harnesses.
- **FR-014**: The driver boundary MUST allow a non-ACP driver without changing the run API.
- **FR-015**: The conformance suite MUST cover prompt, streaming, permission allow and deny, cancel, process death and capability refusal.

### Key Entities

- **Harness**: A named way to start an agent, with profile, command and verification level.
- **Run**: One supervised execution from start to terminal state.
- **Turn**: One prompt within a run.
- **RunEvent**: One ordered, normalised item in a run's stream.
- **Capabilities**: What the connected agent has negotiated.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Switching harness needs a change to one input value only.
- **SC-002**: All conformance cases pass against the fake agent with no credentials or network inference.
- **SC-003**: Every failure in the edge-case list produces a named error code and a terminal event.
- **SC-004**: No child process remains after any tested run outcome.

## Assumptions

- Harness CLIs are installed and authenticated by the user.
- `claude` and `codex` are reached through their ACP adapters; other harnesses use their documented ACP modes.
- OpenBot has no documented ACP mode and is out of scope here; it needs a separate driver and a decision on which project is meant.
- `openclaw` is gateway-backed, so workspace and sandbox guarantees may differ from coding harnesses.
- This feature adds no persistence. Durable runs, placement and remote recovery belong to `node` and `hub`.
- The Java, Go and React code stays untouched by this feature.
