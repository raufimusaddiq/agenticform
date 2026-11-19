<!--
Sync note, version 2.0.0 (2026-11-19): amends principle IV. Permission requests follow the run's permission policy, which defaults to allow inside the sandbox. The sandbox (writes only inside the workspace and declared state dirs, private /tmp and home, cleared env) is the safety boundary, as a rig worktree is for rig's own agents. A run may opt out with `ask` (deny at timeout) or `deny`. Fail closed still holds when the sandbox is unavailable, for unknown capabilities, ambiguous replays, fencing, nonces and credentials. Harness-native auto or bypass permission modes, such as claude-agent-acp's auto mode from 0.101, are consistent with the `allow` default, because the sandbox is the boundary. Specs 001 (FR-008, US3, research) and 004 (remote answers apply only to policy `ask`), docs/architecture.md and README are updated in the same PR. MAJOR bump: a NON-NEGOTIABLE principle is weakened.
Version 1.0.0: first ratified constitution for the execution-fabric direction.
-->
# Agenticform Constitution

## Purpose

Agenticform is a small execution fabric. It runs coding agents and agent platforms on any enrolled machine behind one API, so applications, scripts and other agents can use them as a library or service.

## Core Principles

### I. Execution, Not Orchestration

Agenticform owns runs: placement, process lifecycle, events, permissions and results. Callers own planning, task graphs, project management and roles. Features that decide what work should happen belong in a caller, not in the core.

### II. Library First

Every capability starts in a package that works without a server. `runtime` must run a harness locally on its own. `node`, `hub`, `client`, the CLI and MCP are added layers and must not leak into `runtime`. HTTP is the single remote contract; CLI and MCP stay thin clients with no separate logic.

### III. One Contract, Honest Differences

ACP is the default integration, and one API covers every harness. Harness differences stay visible: each harness declares a profile and capabilities, callers declare requirements, and missing requirements fail with a named error. Emulated behaviour is marked as emulated. A direct driver is allowed only for a need ACP cannot meet, recorded with its reason.

### IV. Fail Closed (NON-NEGOTIABLE)

Permission requests follow the run's permission policy, which defaults to `allow` inside the sandbox: the sandbox is the safety boundary, not a per-request prompt. A run with policy `ask` denies an unanswered request at its timeout, and policy `deny` refuses every request. Without a working sandbox there is no run. Unknown capabilities count as absent. Ambiguous side effects are never replayed automatically. Remote execution keeps outbound-only nodes, fenced runtime identity, single-use nonces and idempotency. Credentials never enter events, logs or the hub.

### V. Bring Your Own Harness

Users install, update and authenticate harness CLIs themselves. Agenticform detects them, reports problems clearly and does not manage them or measure their resource use.

### VI. Proof Over Claims

A harness is listed as tested only after the conformance suite passes against a recorded version. Documentation-based support is labelled as such. Adapter and CLI versions are pinned; upgrades repeat the suite. Tests target contracts and failure boundaries, not counts or coverage percentages.

### VII. Stay Small

Prefer deleting to porting. Add a feature only for a present need. No speculative abstraction, no new layer without a second real user, and no dependency that a few lines of clear code can replace.

## Technical Constraints

- TypeScript on a pinned stable Bun release, in one workspace. Packages stay usable from Node where practical.
- ACP protocol v1 through the official SDK's stable entrypoint. v2 is adopted deliberately once it leaves draft.
- Memory goals are verified by measurement, excluding harness CLIs.

## Development Workflow

- Non-trivial work follows Spec Kit: specify, plan, tasks, implement. Specs in `specs/` are the source of truth for new work.
- PRs state behaviour, validation results and any constitution exception.
- Documentation that a change supersedes is amended in the same PR.

## Governance

This constitution overrides other project guidance. Amendments require a PR explaining the reason and any migration. Versions follow semantic rules: MAJOR for removed or redefined principles, MINOR for additions, PATCH for wording.

**Version**: 2.0.0 | **Ratified**: 2026-11-05 | **Last Amended**: 2026-11-19
