# Agenticform

Agenticform is a small execution fabric for coding agents. It gives applications, scripts and other agents one way to run Claude Code, Codex, OpenCode, omp, Pi, DeepSeek Harness and similar tools.

> **Status:** early. The local `runtime` package, the `node` daemon and the `hub` exist. The earlier Java, Go and React stack has been removed; its history stays in git.

## What it does

```ts
import { createRuntime } from "@agenticform/runtime"

const run = createRuntime().run({
  harness: "codex",
  cwd: "/absolute/path/to/repo",
  prompt: "Fix the failing tests",
  onPermission: () => "deny",
})

for await (const event of run.events()) {
  if (event.type === "message.delta") process.stdout.write(event.text)
}

const result = await run.result()
```

Changing `harness` is the only edit needed to use another agent. When a harness cannot meet a run's stated requirements, the run fails with a named error rather than degrading silently.

Agenticform runs work. Callers decide what work to do, so planning and task management belong in the application using it.

## Try it

You need [Bun](https://bun.sh) and a harness that is already installed and logged in.

```bash
bun install
bun test packages
bun packages/runtime/examples/run.ts codex . "Summarise this repository"
bun packages/node/examples/end-to-end.ts
```

The last command runs a real node against a fake hub and a fake agent, so it needs no harness and no credentials.

## Clean install and one run

From a fresh clone, with nothing else installed but Bun:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test packages
bun packages/node/examples/end-to-end.ts
```

The last step is the run journey: a real node enrolls, heartbeats, leases one
`run.start`, streams events and completes, against a fake hub and a fake agent.
It writes only to a temporary state directory and removes it, so it needs no
harness, no credentials and no database. `packages/node/test/journey.test.ts`
runs the same journey as part of `bun test packages`.

## Packages

| Package | Purpose | Status |
|---|---|---|
| `runtime` | Local runs, ACP driver, events, capabilities | Available |
| `node` | Daemon on each machine, isolation, recovery | Available |
| `hub` | Connection point, placement, fencing, HTTP API | Available |
| `client` | TypeScript SDK for the HTTP API | Available |
| CLI, MCP | Thin clients of the HTTP API | Available |

## Configuration

Every environment variable below is read by at least one package. Empty defaults mean the feature is off until set. Secrets are marked; never put a real value in a file that is committed.

The hub also serves a small operator UI at `/` from the same origin. It asks for the admin token in the browser, keeps it in `sessionStorage`, and sends it only in the `Authorization` header; the token never appears in a URL, the page, or a log.

The CLI (`af`) and the MCP server (`agenticform-mcp`) are thin clients of the same API. Both read `AGENTICFORM_HUB_URL` and `AGENTICFORM_ADMIN_TOKEN` from the environment and never accept the token as an argument.

```bash
af nodes
af run start --key job-1 --harness codex --prompt "Fix the failing tests"
af run get <runId>
af run events <runId> --follow
af run cancel <runId>
```

| Variable | Package | Default | Meaning |
|---|---|---|---|
| `AGENTICFORM_ADMIN_TOKEN` | hub, cli, mcp | none (required) | Secret. Bearer token for caller and operator routes; the hub refuses to start below 32 characters |
| `AGENTICFORM_HUB_URL` | hub, node, cli, mcp | none (required except in hub) | Public origin. Nodes, CLI and MCP require it; a non-local value must be HTTPS |
| `AGENTICFORM_STATE_DIR` | hub, node | `$HOME/.agenticform-hub`, `$HOME/.agenticform-node` | Directory for durable state |
| `AGENTICFORM_HUB_DB` | hub | `$AGENTICFORM_STATE_DIR/hub.sqlite` | Explicit SQLite database path |
| `AGENTICFORM_HUB_PORT` | hub | `8787` | Listen port |
| `AGENTICFORM_HEARTBEAT_SECONDS` | hub, node | `15` | Heartbeat interval advertised to nodes, and the interval a node sends at |
| `AGENTICFORM_POLL_MS` | hub, node | `1500` | Empty-poll backoff advertised to nodes, and a node's poll interval |
| `AGENTICFORM_LEASE_SECONDS` | hub | `900` | Command lease length |
| `AGENTICFORM_LEASE_RENEW_SECONDS` | node | `300` | How often a node renews its lease |
| `AGENTICFORM_REQUEST_TIMEOUT_SECONDS` | node | `30` | Per-request timeout when calling the hub |
| `AGENTICFORM_HARNESS_PROBE_TTL_SECONDS` | node | `300` | How long a non-ready harness probe result is cached before the next heartbeat re-probes |
| `AGENTICFORM_HARNESS_PROBE_READY_TTL_SECONDS` | node | `3600` | How long a `ready` harness result is cached; a ready harness is stable, so it is probed less often |
| `AGENTICFORM_HARNESS_PROBE_TIMEOUT_SECONDS` | node | `20` | Per-harness probe timeout; a hung harness becomes `unknown` and the heartbeat keeps beating |
| `AGENTICFORM_CLOCK_SKEW_SECONDS` | hub | `120` | Allowed signed-request clock skew |
| `AGENTICFORM_NODE_OFFLINE_SECONDS` | hub | `45` | Silence before a node is `OFFLINE`; must exceed the heartbeat interval |
| `AGENTICFORM_ENROLLMENT_TTL_SECONDS` | hub | `600` | Enrollment token lifetime |
| `AGENTICFORM_NONCE_TTL_SECONDS` | hub | `600` | Signed-request nonce lifetime |
| `AGENTICFORM_NONCE_CLEANUP_SECONDS` | hub | `600` | Nonce cleanup interval |
| `AGENTICFORM_RECOVERY_GRACE_SECONDS` | hub | `120` | Wait before a disconnected run may recover |
| `AGENTICFORM_MAX_BODY_BYTES` | hub | `1048576` | Maximum request body before `413 payload_too_large` |
| `AGENTICFORM_ENROLL_TOKEN` | node | none (required for `agenticform-node enroll`) | Secret. Single-use enrollment token issued by the hub |
| `AGENTICFORM_NODE_NAME` | node | hostname | Name reported at enrollment |
| `AGENTICFORM_NODE_SLOTS` | node | `1` | Concurrent commands the node accepts |
| `AGENTICFORM_NODE_HARNESSES` | node | empty (none) | Comma-separated harness ids the node advertises |
| `AGENTICFORM_NODE_CAPABILITIES` | node | empty (none) | Comma-separated capability overrides for the node |
| `AGENTICFORM_CONFORMANCE_HARNESS` | runtime | unset (suite skipped) | Opt-in: run the conformance suite against this harness; may use paid inference |
| `AGENTICFORM_CONFORMANCE_CWD` | runtime | process cwd | Working directory given to the conformance harness |

## Memory

Idle resident memory, measured 2026-11-18 on the 1 CPU / 2 GB development host:
`hub` 25.7 MB, `node` 44.4 MB. Method: start each process alone with a temporary
state directory, wait two seconds after it reports ready, then read `VmRSS` from
`/proc/<pid>/status`. The node is higher because it loads `runtime` and the ACP
driver. These are idle figures; a run adds the harness process.

## Documentation

- [Architecture](docs/architecture.md)
- [Supported harnesses](docs/harnesses.md)
- [Constitution](.specify/memory/constitution.md)
- [Runtime spec](specs/001-runtime-foundation/spec.md)
- [Node and hub spec](specs/002-node-hub/spec.md)

## Development

New work follows [Spec Kit](https://github.com/github/spec-kit): specify, plan, tasks, implement. Specs live in `specs/`.

```bash
bun run typecheck
bun test packages
```

To run the conformance suite against a real harness, which may use paid inference:

```bash
AGENTICFORM_CONFORMANCE_HARNESS=codex bun test packages
```
