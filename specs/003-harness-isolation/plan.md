# Implementation Plan: Harness Isolation and Presence

**Branch**: `003-harness-isolation` | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-harness-isolation/spec.md`

## Summary

Wrap every harness child in a bubblewrap sandbox built from a per-harness profile:
minimal read-only system binds, a private tmpfs home and `/tmp`, the workspace
bound read-write or read-only, and only the harness's declared state directories.
Probe each configured harness inside that sandbox, classify it `ready`, `missing`,
`unauthenticated` or `unknown`, advertise only ready ones, and add the full report
plus the isolation mode to the heartbeat as optional fields. When no sandbox can
be created, advertise nothing and refuse runs with `isolation_unavailable`.

No `runtime` change: the node passes a harness definition override whose command
is `bwrap`, so `runtime`'s spawn path and process-group handling stay as they are.
No `protocol` version bump: the new heartbeat fields are optional and additive.

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.4, node entry point avoiding Bun-only
APIs so it also runs on Node 22+

**Primary Dependencies**: none new; `node:child_process` for the self-test,
`bwrap` (system binary, owner-provided like a harness), `sandbox-exec` on macOS

**Storage**: none; probe cache and self-test result are in memory

**Testing**: `bun test` with a fake agent that attempts writes and reports
`auth_required`; real `bwrap` against a temporary workspace on the test host;
the suite skips the sandbox cases when `bwrap` is absent and says so

**Target Platform**: Linux (bubblewrap) and macOS (sandbox-exec, documented as
best-effort); the delivery host is Linux 6.8 with bubblewrap 0.9.0

**Project Type**: Library package change (`packages/node`) plus docs and contracts

**Constraints**: fail closed, no new dependencies, no protocol version bump, no
harness credentials read, harness stderr stays out of events and heartbeats

**Scale/Scope**: one sandbox per run, one probe at a time, at most eight catalog
harnesses, designed for a 1 CPU / 2 GB node

## Constitution Check

*GATE: checked before design and re-checked after contracts.*

| Principle | Result |
|---|---|
| I. Execution, Not Orchestration | Pass: isolation and presence only; no placement policy, tasks or projects. |
| II. Library First | Pass: the sandbox lives in `node`; `runtime` runs alone and is unchanged. The base 002 design already keeps `runtime` free of isolation. |
| III. One Contract, Honest Differences | Pass: gateway-backed agentic harnesses are documented as not covered by local-process isolation; they are not claimed equal. Each harness's mounts are declared, not inferred. |
| IV. Fail Closed | Pass: no primitive → no advertisement, no run, named error; no unsandboxed retry; environment cleared so node secrets do not leak; probe reads no credentials. |
| V. Bring Your Own Harness | Pass: the node detects and reports; it never installs, updates or authenticates, and the probe cannot download. |
| VI. Proof Over Claims | Pass: each guarantee has a test per catalog entry; the self-test proves the primitive rather than checking for a binary; the table is the contract. |
| VII. Stay Small | Pass: one system binary, no library, no native addon, additive heartbeat fields, no new error-layer machinery. Landlock was rejected because it needs a binding bwrap already replaces. |

No violations. No complexity table.

## Project Structure

### Documentation (this feature)

```text
specs/003-harness-isolation/
├── plan.md
├── spec.md
├── research.md
├── tasks.md
└── contracts/
    ├── isolation.md
    └── harness-detection.md
```

### Source Code (repository root, for the implement tickets)

```text
packages/node/
├── src/isolation.ts        # profile table, argv builder, self-test
├── src/harness-probe.ts    # resolve, handshake probe, classification, cache
├── src/executor.ts         # apply the sandbox override, map probe errors
├── src/node.ts             # report ready harnesses, harnessReport, isolation
├── src/config.ts           # AGENTICFORM_ISOLATION, probe TTL and timeout
└── test/isolation.test.ts  # write denial per catalog entry, env allowlist
    test/probe.test.ts      # ready / missing / unauthenticated / unknown
    test/fail-closed.test.ts# no primitive → no spawn, named error
```

`packages/protocol/src/index.ts` gains the two optional heartbeat fields as types
only; no behaviour change. `packages/hub` changes one message string in
`placement.ts` (FR-025) and otherwise ignores the new fields.

**Structure Decision**: one new module for the sandbox and one for probing. They
have different failure modes (a sandbox that cannot start versus a harness that
cannot log in) and different tests, and combining them would make the fail-closed
path harder to read. Nothing is extracted into a shared package: `node` is the
only user.

## Design Notes

### Sandbox as a harness override

`runtime.run` already accepts a harness definition with `command`, `args` and
`env`. The node maps profile → argv and passes:

```ts
{ ...definition, command: "bwrap", args: [...sandboxArgs, "--", definition.command, ...definition.args] }
```

This keeps `runtime` free of sandbox concepts, keeps the process-group and
cancel behaviour already tested in 002, and means an unsupported primitive is a
failure at argv-build time, not a new spawn path.

### Profiles

`workspace: "write" | "read-only"` plus `rw`/`ro` state paths, an env allowlist
and a version. The default profile for the workspace is `write`. The default for
an unknown harness is an empty profile: no state paths, empty home. Profile
entries are data, not logic, so a harness addition is a table row.

### Self-test

At startup, build the exact argv for an empty profile and run `true` inside it
with a temp workspace. Pass only if the exit status is zero within 10 s. Cache
the result; a failure means `isolation.mode: "none"`, no advertised harnesses and
`isolation_unavailable` for every run. Re-test on the first run after a failure
is not attempted: fail closed and stay there until restart, so a transient
failure cannot cause a flapping advertisement.

### Probe

Resolve the entry point without network, then run the handshake inside the
sandbox with a 20 s timeout. The handshake is ACP `initialize` plus
`session/new`, because `auth_required` only surfaces at `session/new`. Classify
to a status and a reason code. Cache a non-ready result for 300 s and a `ready`
one for 1 h; invalidate on a failed run. One probe at a time. The probe reuses
the `runtime` handshake path rather than a second ACP implementation.

### Placement

The hub already places on advertised harnesses. The only change is the message:
when no node advertises the requested harness, name the harness and, if any node
reported it, the best-known status. No new error code: placement still fails with
`no_eligible_node`.

### Errors

| Code | Where | HTTP |
|---|---|---|
| `harness_missing` | node run failure, terminal event | 422 when surfaced by the hub |
| `harness_unauthenticated` | node run failure, terminal event | 422 |
| `harness_unavailable` | node run failure for `unknown` | 422 |
| `isolation_unavailable` | node startup and run failure | 500 |

All four are terminal run errors and never retried automatically.

## Testing Strategy

- **Contract**: argv shape for every profile, the env allowlist, the mount table,
  the probe classification table, the heartbeat fields.
- **Failure boundaries**: write outside the workspace per catalog entry; write
  inside a `read-only` profile; sandbox missing; self-test failure; probe
  timeout; `auth_required`; version not cached.
- **Real process**: the write-denial tests run a fake child under real `bwrap` on
  the test host, skipping with a printed reason when `bwrap` is absent.
- **Unaffected**: `bun test packages` still passes for `runtime`, `hub`, `node`
  and `protocol`; `bun run typecheck` passes.

## Complexity Tracking

No constitution exceptions.
