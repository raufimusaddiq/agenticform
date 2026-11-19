# Feature Specification: Close Open Issue Gaps

**Feature Branch**: `004-close-issue-gaps`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description: "close the open issue gaps and update status"

## Scope

This feature closes the remaining acceptance gaps in the open GitHub issues of the
rebuild (#73) and brings each issue's status in line with the code. An audit on
2026-11-19 found #74, #76, #78, #80 and #84 delivered. The remaining gaps are:

| Issue | Gap |
|---|---|
| #86 | no scoped caller token; no run lineage or depth limit; no remote answer to permission requests |
| #79 | no multi-hour soak; no journey across two machines with two harnesses; no packaging decision |
| #81 | memory result not recorded on the parent ticket |
| #75 | before/after CI job-minutes not recorded |
| #73 | Goal and Scope still describe tasks and projects |

Owner decision (2026-11-19): answering permission requests remotely is in scope
and owner-only. This reverses the exclusion of approvals in spec 002 for permission
requests only. A task, project or approval-board model stays out (constitution I).

Out of scope: multi-user accounts, a new login system, task or project state,
harness installation or authentication, and changes to the wire protocol version.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A calling agent works without the admin token (Priority: P1)

The owner gives an outside agent a token that can start runs, read them and cancel
them, and nothing else. If the token leaks, the owner revokes it without changing
the admin token, and the damage is limited to running work on the owner's machines.

**Why this priority**: Today every caller holds the admin token, which can enrol and
revoke machines. That is the largest remaining security gap in #86.

**Independent Test**: Issue a scoped token, use it to submit, follow and cancel a run
through HTTP, CLI and MCP, then try to enrol a machine, disable a node, issue a token
and answer a permission request with it. The first three succeed; every other call is
refused. Revoke the token and repeat a read: it is refused.

**Acceptance Scenarios**:

1. **Given** a scoped token, **When** the caller submits, reads, follows or cancels a run, **Then** the call succeeds exactly as it would with the admin token.
2. **Given** a scoped token, **When** the caller tries to enrol a machine, change a node's status, issue or revoke a token, or answer a permission request, **Then** the call is refused with a named error and nothing changes.
3. **Given** a revoked token, **When** it is used for any call, **Then** the call is refused, including a follow that was already open.
4. **Given** the owner, **When** they list tokens, **Then** they see each token's name, scope, creation and last-use time, and never the token's secret.

---

### User Story 2 - The owner answers a run's permission request remotely (Priority: P1)

A harness running on a remote machine asks to run a command. The owner sees the
pending request through HTTP, CLI, MCP or the UI, and allows or denies it. If nobody
answers in time, the request is denied.

**Why this priority**: Without this, every permission request is denied, so a
harness that asks before editing cannot do useful work remotely. #73 and #86 both
require it.

**Independent Test**: Run a fake harness that asks permission once. Allow it through
each interface in turn and confirm the harness continues; deny it and confirm the
harness sees a denial; leave it unanswered and confirm it is denied at the timeout.

**Acceptance Scenarios**:

1. **Given** a run whose harness asks permission, **When** the owner lists the run's pending requests, **Then** the request appears with its tool, a short description and the options the harness offered.
2. **Given** a pending request, **When** the owner picks one of the offered options, **Then** the harness receives that answer and the run's events record the decision.
3. **Given** a pending request, **When** nobody answers before the timeout, **Then** it is denied and the run's events record that it timed out.
4. **Given** a request that is already answered or timed out, **When** an answer arrives, **Then** it is refused with a named error and the harness is not told twice.
5. **Given** a scoped token, **When** it tries to answer, **Then** it is refused (User Story 1).

---

### User Story 3 - A run started by an agent cannot spawn work without bound (Priority: P2)

An agent working inside a run starts another run through the MCP server, which
starts another. Each run records which run started it, and a chain longer than the
limit is refused.

**Why this priority**: A runaway chain burns the owner's harness quota and machine
capacity. It matters as soon as agents can submit runs, but needs User Story 1 first.

**Independent Test**: Submit a chain of runs, each naming the previous one as its
parent, until the limit; the next submission fails with a named error and creates no
run.

**Acceptance Scenarios**:

1. **Given** a submission that names a parent run, **When** it is accepted, **Then** the new run records its parent and its depth, the parent's depth plus one.
2. **Given** a parent at the depth limit, **When** a child is submitted, **Then** it fails with `depth_exceeded` and no run is created.
3. **Given** a submission naming a parent that does not exist, **When** it is submitted, **Then** it fails with a named error.
4. **Given** a repeated idempotency key, **When** it is resubmitted with a parent, **Then** one run exists, as today.

---

### User Story 4 - The node is proven on real machines (Priority: P2)

Before the rebuild is called finished, the owner has evidence that the node survives
hours of work and restarts, runs two different harnesses on a second machine, and
ships as a package that contains only what it needs.

**Why this priority**: These are the remaining "Done" items of #79 and #81. They
produce evidence rather than features, so they follow the security work.

**Independent Test**: Run the soak and the two-machine journey on Linux hosts and
read the recorded results.

**Acceptance Scenarios**:

1. **Given** a node and hub running a repeating mix of runs for at least four hours, with the node restarted at least three times, **When** the soak ends, **Then** memory has not grown without bound, no harness process is left orphaned, and every run reached a terminal state.
2. **Given** a hub on one machine and a node on another with two ready harnesses, **When** a run is placed on each harness, **Then** both complete, a run that asks permission is answered remotely, and the node opens no inbound port.
3. **Given** that journey, **When** the node is stopped mid-run and restarted, **Then** the run is recovered or failed with a named reason, a stale generation is rejected, and a request with a bad signature does not use up a nonce.
4. **Given** the packaging test, **When** it builds the node, **Then** the package contains only the node and its sandbox dependency, and the choice between a compiled binary and a Bun install is recorded with its measured size and start time.

---

### User Story 5 - Every issue says what is true (Priority: P3)

The owner opens the issue tracker and sees only issues with work left. Each closed
issue links the evidence that closed it, and the parent issue describes the current
direction.

**Why this priority**: Status hygiene, cheap once the work above lands.

**Independent Test**: Read each issue of the rebuild and compare it with the code.

**Acceptance Scenarios**:

1. **Given** a delivered issue, **When** its evidence is posted, **Then** it is closed with a comment naming the PRs and files that satisfy it.
2. **Given** an issue with remaining work, **When** status is updated, **Then** its comment lists the remaining items and links this spec.
3. **Given** #75, **When** its measurement is recorded, **Then** it states CI job-minutes per PR before and after the CI change, measured from run history, and is closed.
4. **Given** #73, **When** every child is closed, **Then** its Goal and Scope match the execution-fabric direction, the memory result is recorded on it, and it is closed.

---

### Edge Cases

- A scoped token is revoked while a follow is open: the stream ends with a named error at its next event or keepalive, at most 30 s later.
- The admin token is used where a scoped token would do: allowed, since the admin token keeps every right it has today.
- Two answers to the same permission request arrive together: exactly one is applied and the other is refused.
- A permission request is pending when the run is cancelled: the request ends as cancelled, and a later answer is refused.
- The node restarts while a permission request is pending: the request is not re-asked from the hub's record; the run follows its normal recovery and the request ends as cancelled.
- A permission answer names an option the harness did not offer: refused, and the request stays pending.
- An agent submits a child run with a token whose scope does not include submit: refused before the depth check.
- A run names itself or a descendant as parent: impossible, because the parent must already exist when the child is created.
- The soak host runs out of disk: the soak fails and says so; it is not reported as a pass.
- An issue's evidence is a PR that was later reverted: the issue is not closed on that evidence.

## Requirements *(mandatory)*

### Scoped caller tokens

- **FR-001**: The owner MUST be able to issue a named caller token with the scope `runs`, allowing submit, read, follow and cancel of runs and listing machines and their harnesses.
- **FR-002**: A `runs` token MUST be refused for enrolment, enrolment-token issue, node status changes, token management and permission answers, with the named error `forbidden`.
- **FR-003**: The owner MUST be able to list and revoke caller tokens with the admin token. A revoked token MUST be refused on its next use, and an open follow MUST end within 30 s.
- **FR-004**: The hub MUST store only a one-way digest of each caller token, show the secret once at issue, and never return it again or write it to events, logs or the UI.
- **FR-005**: The CLI and MCP server MUST accept a caller token in place of the admin token from the environment only, never as an argument, and MUST behave identically apart from refused calls.
- **FR-006**: The admin token MUST keep every right it has today.

### Remote permission answers

- **FR-007**: A harness permission request in a hub-placed run MUST be recorded as pending on the hub with the run, the tool, a short description and the offered options, and MUST appear in the run's events.
- **FR-008**: Only the admin token MUST be able to answer a pending request, through HTTP, CLI, MCP and the UI, by choosing one of the offered options.
- **FR-009**: An answer MUST reach the harness at most once. A second answer, an answer to a resolved request, or an option that was not offered MUST be refused with a named error.
- **FR-010**: A request left unanswered MUST be denied at the timeout. The default is 300 s, the same as the local runtime.
- **FR-011**: A request MUST end as cancelled when its run is cancelled, fails or loses its node, and MUST NOT be replayed after a node restart.
- **FR-012**: The node MUST receive answers over its existing outbound connection; no inbound listener is added.
- **FR-013**: Permission request text MUST be bounded in length and MUST NOT include harness stderr.

### Run lineage and depth

- **FR-014**: A submission MAY name a parent run. The hub MUST record the parent and a depth (0 for a run with no parent, else the parent's depth plus one).
- **FR-015**: A submission whose depth would exceed the limit MUST fail with `depth_exceeded` and create no run. The default limit is 3, set by the owner in the hub's configuration.
- **FR-016**: A submission naming an unknown parent MUST fail with `parent_not_found`.
- **FR-017**: The MCP server MUST pass the parent run when the caller supplies it. A run started from inside another run is expected to name its parent; the hub does not infer one.

### Release evidence

- **FR-018**: A soak procedure MUST run node and hub for at least four hours with at least three node restarts, and record peak and final resident memory, orphaned harness processes, and runs without a terminal state.
- **FR-019**: A two-machine journey MUST run with the hub and node on separate Linux hosts and two ready harnesses, and cover: completion on both harnesses, a remote permission answer, node-loss recovery, stale-generation rejection and a bad signature that does not consume a nonce.
- **FR-020**: A packaging test MUST build the node package, list its contents, and record the binary-versus-Bun-install decision with measured size and start time.
- **FR-021**: The measured idle and soak memory of hub and node MUST be recorded on #73. The record MUST state that the legacy stack has no baseline (`docs/node-hub-invariants.md`).

### Issue status

- **FR-022**: Each delivered issue MUST be closed with a comment that names its evidence: PRs, files and tests.
- **FR-023**: Each issue with remaining work MUST carry a comment that lists that work and links this spec, and MUST be closed only when that work lands.
- **FR-024**: #75 MUST record CI job-minutes per PR before and after the CI change, taken from the repository's run history.
- **FR-025**: #73's Goal and Scope MUST be amended to the execution-fabric direction before it is closed.

### Key Entities

- **CallerToken**: name, scope (`runs`), digest, created-at, last-used-at, revoked-at.
- **PermissionRequest**: run, request id, tool, description, offered options, status (`pending`, `answered`, `timed_out`, `cancelled`), decision, decided-at.
- **RunLineage**: a run's parent run and depth.
- **ReleaseEvidence**: soak, two-machine journey and packaging results, with host, date and versions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A scoped token completes submit, follow and cancel through all three interfaces and is refused on 100% of owner-only operations.
- **SC-002**: A revoked token is refused on its next call, and an open follow ends within 30 s.
- **SC-003**: Every permission request ends in exactly one outcome (answered, timed out or cancelled), and a harness is never answered twice.
- **SC-004**: A chain of submissions stops at the configured depth with `depth_exceeded`, and no run is created past it.
- **SC-005**: A four-hour soak with three restarts ends with zero orphaned harness processes, zero runs without a terminal state, and memory at the end within 20% of memory after the first hour.
- **SC-006**: A run on each of two harnesses completes on a machine other than the hub's.
- **SC-007**: After the update, every open issue of the rebuild has work remaining, and every closed one links its evidence.

## Assumptions

- "Multi-hour soak" in #79 is taken as four hours; longer runs are welcome but not required.
- The second machine may be a Linux VM on another host; it must not share a process namespace with the hub.
- The two harnesses for the journey are ones the owner already has installed and authenticated (constitution V), for example `claude` and `opencode`.
- The scoped token is the one deliberate addition to the auth model named in #86. The admin bearer token and the UI login stay as they are.
- A single scope, `runs`, covers today's need; more scopes are added only when a real caller needs them (constitution VII).
- The depth limit of 3 is a default; #86 asks for a bound, not a value.
- Permission answers are owner-only because #86 says approval answers stay with the owner.
- CI job-minutes come from the repository's run history; no pricing is promised (#75).
- Release evidence needs Linux hosts with bubblewrap. It cannot be produced on the Windows development machine.
