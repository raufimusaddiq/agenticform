# Architecture

Agenticform is an execution fabric. Callers decide what should happen; Agenticform runs it on a chosen harness and machine and reports what happened.

```text
applications / scripts / agents
        │ library, HTTP, CLI or MCP
        ▼
client ─────► hub ◄───── node (machine A) ─► harness
              ▲
              └───────── node (machine B) ─► harness

runtime: used by node, and on its own for local runs
```

`runtime`, `node`, `hub`, `client`, the CLI and the MCP server exist. The
distributed path is implemented; the sections below describe how it fits
together.

## Layers

**`runtime`** starts a harness, negotiates capabilities, runs turns and normalises events. It works alone, with no server.

**`node`** runs on each machine. It applies isolation and recovery, and connects outbound to the hub, so machines expose no inbound port.

**`hub`** is the connection point for nodes. It owns placement, fencing and the HTTP API. It never holds harness credentials.

**`client`** is the TypeScript SDK for the HTTP API. The CLI and MCP server are thin clients of the same API.

## Boundaries

Agenticform owns runs, sessions, events, permissions and results. Callers own tasks, plans, boards, roles and retries. Tools a caller wants the agent to have are passed as MCP servers.

## Why ACP

ACP gives one integration for many harnesses. Direct integrations can reach more harness-specific features, at the cost of one adapter per harness that must track each vendor. Work submitted and collected as runs does not depend on those features.

A direct driver can sit behind the `RuntimeDriver` boundary when a real need cannot be met through ACP. The reason is recorded when one is added.

## Honest differences

The API is uniform; harnesses are not. Each harness has a profile, either `coding` or `agentic`, and each connection reports capabilities. Callers state requirements and get a named error when they are not met.

Steering is emulated by cancelling a turn and sending a new prompt. Events mark it as emulated, because in-progress work is interrupted.

Agentic platforms may run tools through their own gateway, so a sandbox around the local process may not cover them. Those guarantees are not treated as equal to coding harnesses.

## Safety rules

- Permission requests are denied unless a caller allows them. Only one-time grants are selected.
- Unknown capabilities count as absent.
- Prompts are never retried automatically, because a lost reply is ambiguous.
- Harness stderr stays out of events, because it may contain sensitive output.
- The remote path carries outbound-only nodes, fenced runtime identity, single-use nonces, idempotency and isolation. See [node/hub invariants](node-hub-invariants.md).

## Isolation

Every run is wrapped in a bubblewrap sandbox built from the harness's profile:
minimal read-only system binds, a private `/tmp` and home, the resolved
workspace bound read-write (or read-only), and only the harness's declared state
directories. A write outside those paths fails with `EROFS`. The node never runs
a harness unsandboxed: a sandbox that cannot start fails the run.

Still planned (spec 003): the heartbeat does not yet report the isolation mode or
probe harness presence. The design is
[`specs/003-harness-isolation`](../specs/003-harness-isolation/spec.md).

## Process lifecycle

Each run owns one child process, which leads its own process group, so wrappers such as `bunx` are stopped with their children. Cancellation has a grace period, after which the process is stopped.

Runs keep their events in memory. Durability belongs to `node` and `hub`: the
node writes a command ledger before any effect, and the hub keeps runs, commands
and events in SQLite with WAL.

## History

An earlier Java control plane, Go node and React UI were removed once the Bun
packages covered their behaviour. They are not part of this repository; their
code and documentation remain in git history at commit `14a1464`.
