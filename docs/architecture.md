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

Only `runtime` exists today. The rest of this page is the target design.

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
- The remote design carries forward outbound-only nodes, fenced runtime identity, single-use nonces, idempotency and isolation. See the [legacy distributed fabric notes](legacy/distributed-agent-fabric.md).

## Process lifecycle

Each run owns one child process, which leads its own process group, so wrappers such as `bunx` are stopped with their children. Cancellation has a grace period, after which the process is stopped.

Runs keep their events in memory. Durability belongs to `node` and `hub`.
