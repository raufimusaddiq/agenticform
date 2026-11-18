# Feature Specification: Harness Isolation and Presence

**Feature Branch**: `003-harness-isolation`

**Created**: 2026-11-18

**Status**: Implemented

**Input**: User description: "Isolation around the agent process itself: per-harness mounts, read-only vs write profiles, write outside the workspace denied for every supported harness, harness CLIs stay owner-provided separate children. Heartbeat reports harnesses actually installed and authenticated, with a clear named failure when a harness is missing or unauthenticated."

## Scope

This feature adds the isolation boundary and harness presence detection to the
`node` package. It does not change `runtime`'s run API, the hub's placement
algorithm or the wire protocol version; the heartbeat gains optional fields only.

It consumes `docs/node-hub-invariants.md` (N1.1, N7.5) and the packages as they
are on main: `packages/runtime` spawns one child per run, and `packages/node`
executes commands through it. Isolation wraps that child; it does not replace it.

Out of scope: installing, updating or authenticating harnesses (constitution V),
network egress policy, resource limits (CPU, memory, disk), and sandboxing
gateway-backed agentic platforms whose tools run outside the local process.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A run cannot write outside its workspace (Priority: P1)

An operator runs a coding harness on a shared machine. The harness may write
inside the run's workspace and nowhere else. A prompt that tries to modify the
home directory, another project or a system path fails with a filesystem error
instead of succeeding.

**Why this priority**: This is the promise that makes running an untrusted agent
on a machine acceptable. Without it, every other guarantee is advisory.

**Independent Test**: For every harness in the catalog, start a fake child with
that harness's sandbox profile, attempt writes inside the workspace and at
`$HOME`, `/tmp` and a sibling project, and assert the first succeeds and the rest
fail with `EROFS`.

**Acceptance Scenarios**:

1. **Given** a run with the `write` profile, **When** the harness writes inside the workspace, **Then** the write succeeds.
2. **Given** any supported harness, **When** it writes outside the workspace, **Then** the write fails and the run reports the harness's own error, not a silent success.
3. **Given** a run with the `read-only` profile, **When** the harness writes inside the workspace, **Then** the write fails.
4. **Given** a run, **When** the harness process starts, **Then** it is a separate child of the node, in its own process group, and the node never runs harness code in-process.

---

### User Story 2 - Each harness sees only its own state (Priority: P2)

A harness needs its own configuration and session directory to work. It does not
need the operator's SSH keys, other projects or another harness's credentials.
Each harness gets exactly the mounts its profile declares, and an unknown harness
gets none.

**Why this priority**: Read isolation limits what a compromised or confused
harness can exfiltrate. It is separable from write isolation, which is the
larger risk.

**Independent Test**: Start a fake child under each harness profile and assert
that its declared state directory is readable and writable, that `$HOME` is
otherwise empty, and that `~/.ssh` and a sibling project are absent.

**Acceptance Scenarios**:

1. **Given** the `claude` profile, **When** the harness starts, **Then** `~/.claude` is writable and `~/.ssh` does not exist.
2. **Given** a harness with no declared profile, **When** it starts, **Then** it gets an empty home and only the workspace.
3. **Given** any harness, **When** it starts, **Then** the node's own environment (hub URL, admin token, enrollment token) is absent from its environment.
4. **Given** a harness that needs a state directory not in its profile, **When** it fails, **Then** the fix is to amend the profile table, not to widen the mount for every harness.

---

### User Story 3 - No sandbox means no run (Priority: P1)

A machine has no usable isolation primitive, or the primitive is present but
cannot create the sandbox. The node says so and refuses to execute runs. It never
falls back to running the harness unsandboxed.

**Why this priority**: A silent fallback turns a security control into a
decoration. Fail closed is non-negotiable (constitution IV).

**Independent Test**: Run the node with the sandbox binary hidden from `PATH` and
assert startup or the first run fails with `isolation_unavailable`, no harness
child is spawned, and the heartbeat reports `isolation.mode: "none"`.

**Acceptance Scenarios**:

1. **Given** no sandbox primitive, **When** the node starts, **Then** it reports `isolation_unavailable` and advertises no harnesses.
2. **Given** a sandbox binary that exists but cannot create a sandbox, **When** the self-test runs, **Then** the node treats it as unavailable.
3. **Given** a sandbox that fails for one run, **When** the run starts, **Then** the run fails with `isolation_unavailable` and no unsandboxed retry happens.
4. **Given** a node with working isolation, **When** it heartbeats, **Then** the heartbeat names the mode and the profile version.

---

### User Story 4 - The heartbeat tells the truth about harnesses (Priority: P1)

An operator installs three harnesses and logs in to two. The node's heartbeat
reports which are ready, which are missing and which need a login. A run that
asks for a harness that is not ready fails with a named error that says which.

**Why this priority**: Placement is only as honest as the inventory. Advertising
a harness that cannot start turns a clear failure into an opaque one.

**Independent Test**: With one fake harness that handshakes, one that exits with
`auth_required` and one absent, assert the heartbeat reports `ready`,
`unauthenticated` and `missing`, and that a run for each non-ready harness fails
with `harness_unauthenticated` or `harness_missing`.

**Acceptance Scenarios**:

1. **Given** an installed and authenticated harness, **When** the node probes it, **Then** it is `ready` and appears in the advertised harness list.
2. **Given** an installed harness that answers `auth_required`, **When** the node probes it, **Then** it is `unauthenticated`, is not advertised, and a run for it fails with `harness_unauthenticated`.
3. **Given** a harness whose entry point is absent, **When** the node probes it, **Then** it is `missing` and a run for it fails with `harness_missing`.
4. **Given** a probe that times out or crashes, **When** the node classifies it, **Then** the harness is `unknown`, is not advertised, and the reason is reported.
5. **Given** a harness that becomes ready after a login, **When** the probe cache expires, **Then** the next heartbeat advertises it without a node restart.

---

### Edge Cases

- The sandbox binary is present but not executable by the node user: self-test fails, `isolation_unavailable`.
- Unprivileged user namespaces are disabled by the kernel or an LSM: the self-test fails even though the binary exists.
- The workspace path contains a symlink pointing outside itself: the sandbox binds the resolved path, and the symlink target is not writable.
- The workspace is the operator's home directory: the write profile still denies writes to the rest of the home, because only the workspace path is bound.
- A harness writes to `/tmp`: it gets a private tmpfs, so the write succeeds and is invisible to other runs.
- Two runs of the same harness start at once: each gets its own private `/tmp` and its own process group; state directories are shared and the harness must tolerate that.
- A harness needs a network socket: the network namespace is not unshared, so model calls work; filesystem isolation is unaffected.
- A harness is installed but its pinned version is not the cached one: it is `missing` with reason `version_not_cached`, never silently downloaded.
- A probe spawns a harness that hangs: the probe times out, the harness is `unknown`, and the node keeps heartbeating.
- The node's own environment contains a secret: it does not reach the harness, because the environment is cleared and rebuilt from an allowlist.
- A run is cancelled while the harness is sandboxed: the process group is stopped, including wrapper children such as `bunx`.
- The sandbox is available but the harness exits immediately: the run fails with the harness's exit status, not `isolation_unavailable`.

## Requirements *(mandatory)*

### Isolation boundary

- **FR-001**: The node MUST start every harness inside a sandbox that denies writes outside the run's workspace and its declared state directories.
- **FR-002**: The node MUST support two workspace profiles: `write` (workspace writable) and `read-only` (workspace read-only). The default is `write`.
- **FR-003**: The node MUST deny writes outside the workspace for every harness in the catalog, not only for a preferred one.
- **FR-004**: The node MUST run each harness as a separate child process in its own process group, and MUST NOT execute harness code in the node process.
- **FR-005**: The node MUST give each run a private `/tmp` and a private home directory, so one run cannot read another run's temporary files.
- **FR-006**: The node MUST NOT unshare the network namespace; harnesses need egress for model calls.
- **FR-007**: The node MUST clear the harness environment and rebuild it from an allowlist plus the harness's declared variables, so node secrets never reach the harness.
- **FR-008**: The node MUST bind the resolved workspace path, so a symlink cannot redirect a write outside the workspace.

### Mounts and profiles

- **FR-009**: Each harness MUST have a declared mount profile listing the state directories it may read and write; the profile is part of the harness catalog, not of the run request.
- **FR-010**: A harness with no declared profile MUST get an empty home and only the workspace.
- **FR-011**: The node MUST mount system paths read-only and MUST NOT mount the operator's home directory as a whole.
- **FR-012**: A profile change MUST be a catalog edit plus a conformance run; the node MUST NOT widen mounts at runtime in response to a harness failure.

### Availability and fail-closed

- **FR-013**: The node MUST detect a usable isolation primitive at startup with a self-test that exercises the exact sandbox shape used for runs.
- **FR-014**: When no primitive is usable, the node MUST report `isolation_unavailable`, MUST advertise no harnesses and MUST NOT execute runs.
- **FR-015**: A sandbox failure for one run MUST fail that run with `isolation_unavailable`; the node MUST NOT retry unsandboxed.
- **FR-016**: The heartbeat MUST report the isolation mode and profile version, so an operator can see whether a node is sandboxed.

### Harness presence and authentication

- **FR-017**: The node MUST probe each configured harness and classify it as `ready`, `missing`, `unauthenticated` or `unknown`, with a machine-readable reason.
- **FR-018**: A harness is `ready` only when its entry point resolves without network access and an ACP `initialize` and `session/new` handshake completes inside the sandbox.
- **FR-019**: The probe MUST NOT install, update or authenticate a harness, and MUST NOT read harness credentials.
- **FR-020**: The probe MUST be bounded by a timeout and run at most one at a time, so a hung harness cannot stall the heartbeat.
- **FR-021**: Probe results MUST be cached for a bounded TTL, longer for `ready` than for non-ready, and re-probed after a run fails, so a login is picked up without a restart.
- **FR-022**: The heartbeat MUST advertise only `ready` harnesses in the existing harness list, and MUST report every probed harness with its status and reason in an additive field.
- **FR-023**: A run for a `missing` harness MUST fail with `harness_missing`; a run for an `unauthenticated` harness MUST fail with `harness_unauthenticated`; neither may start a child.
- **FR-024**: A run for an `unknown` harness MUST fail with `harness_unavailable` and the probe reason.
- **FR-025**: The hub MUST keep placing on advertised harnesses only, and its `no_eligible_node` message MUST name the requested harness and the best-known status when one is reported.

### Security

- **FR-026**: Harness stderr MUST stay out of events and out of the heartbeat, as it may contain credentials.
- **FR-027**: Probe output MUST be reduced to a status and a reason code; raw harness output MUST NOT enter the heartbeat or hub storage.
- **FR-028**: The node MUST NOT log the sandbox argv when it contains a path outside the workspace that could disclose operator layout; it logs the profile name instead.

### Key Entities

- **IsolationProfile**: The sandbox shape for one harness: workspace mode, declared state directories, environment allowlist, profile version.
- **SandboxSelfTest**: The startup check that the primitive can create the exact sandbox shape; pass or fail with a reason.
- **HarnessStatus**: One harness's probe result: id, status, reason, probed-at.
- **ProbeCache**: Bounded, TTL-limited map of harness id to `HarnessStatus`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every harness in the catalog, a write outside the workspace fails and a write inside it succeeds under the `write` profile.
- **SC-002**: No tested run can read `~/.ssh`, another project or another run's `/tmp`.
- **SC-003**: With the sandbox unavailable, zero harness children are spawned and every run fails with `isolation_unavailable`.
- **SC-004**: A heartbeat distinguishes `ready`, `missing`, `unauthenticated` and `unknown` for the same node without a restart.
- **SC-005**: A run for a non-ready harness fails with a named error before any child process starts.
- **SC-006**: No node secret appears in a harness environment in any test.

## Assumptions

- The node runs on Linux with bubblewrap available, or on a platform with an equivalent primitive; the host under test is 1 CPU / 2 GB and has bubblewrap 0.9.0.
- Harnesses are installed and authenticated by the owner (constitution V); the node only observes.
- Harness state directories are stable per user and are declared in the catalog; a wrong entry is a catalog bug.
- Gateway-backed agentic harnesses may run tools outside the local process; the spec claims filesystem isolation for the local child only and says so in the docs.
- The wire protocol stays at version 1; the new heartbeat fields are optional and additive.
- No code in this ticket: the spec, plan, research, tasks and contracts are the deliverable.
