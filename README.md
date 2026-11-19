# Agenticform

Agenticform is a small execution fabric for coding agents. It gives applications, scripts and other agents one way to run Claude Code, Codex, OpenCode, omp, Pi, DeepSeek Harness, Hermes and OpenClaw. Callers decide what work to do; Agenticform runs it and reports what happened, so planning and task management belong in the application using it.

```ts
import { createRuntime } from "@agenticform/runtime"

const run = createRuntime().run({
  harness: "codex",
  cwd: "/absolute/path/to/repo",
  prompt: "Fix the failing tests",
  permissionPolicy: "ask", // the default for the bare runtime, which has no sandbox
  onPermission: () => "deny",
})

for await (const event of run.events()) {
  if (event.type === "message.delta") process.stdout.write(event.text)
}

const result = await run.result()
```

Changing `harness` is the only edit needed to use another agent. When a harness cannot meet a run's stated requirements, the run fails with a named error rather than degrading silently. Permission requests follow the run's `permissionPolicy`. This library has no sandbox, so it defaults to `ask`: `onPermission` decides and silence or no handler denies. `allow` and `deny` are explicit opt-ins. Runs placed through the hub and executed by a node default to `allow`, because the node's sandbox is the boundary (harness-native auto or bypass modes, such as claude-agent-acp's auto mode, are consistent with that).

## Architecture

```text
applications / scripts / agents
        │ library, HTTP, CLI or MCP
        ▼
client ─────► hub ◄───── node (machine A) ─► sandboxed harness
              ▲
              └───────── node (machine B) ─► sandboxed harness
```

| Package | What it is |
|---|---|
| `runtime` | Local runs over ACP: starts a harness, negotiates capabilities, normalises events. Works alone, with no server. |
| `node` | Daemon on each machine. Connects outbound only (no inbound port), keeps a durable command ledger written before any effect, wraps every harness in a bubblewrap sandbox, probes each configured harness and reports the result in the heartbeat. |
| `hub` | Connection point. SQLite (WAL) storage, signed node requests with single-use nonces, lease fencing, placement, the HTTP API and a small operator UI at `/`. It never holds harness credentials. |
| `protocol` | Shared wire types and canonical signing. |
| `client` | TypeScript SDK for the hub's HTTP API. |
| `cli`, `mcp` | `af` and `agenticform-mcp`, thin clients of the same API. |

**Isolation.** The node never runs a harness unsandboxed. At startup it runs a sandbox self-test; if that fails, it advertises no harnesses and refuses every run with `isolation_unavailable` until restart. A harness whose state directory is unusable is reported `state_dir_unusable`, and a run for it fails with `harness_unavailable` before any child starts. Details: [docs/architecture.md](docs/architecture.md).

## Try it

You need [Bun](https://bun.sh). Running a real harness also needs that harness installed and logged in.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test packages
bun packages/runtime/examples/run.ts codex . "Summarise this repository"
bun packages/node/examples/end-to-end.ts
```

The last command runs a real node against a fake hub and a fake agent: it enrolls, heartbeats, leases one `run.start`, streams events and completes. It needs no harness, credentials or database, and writes only to a temporary state directory.

## Remote runs

The hub also serves a small operator UI at `/` from the same origin. It asks for the admin token in the browser, keeps it in `sessionStorage`, and sends it only in the `Authorization` header; the token never appears in a URL, the page, or a log.

The CLI (`af`) and the MCP server (`agenticform-mcp`) are thin clients of the same API. Both read `AGENTICFORM_HUB_URL` and a bearer token from the environment — `AGENTICFORM_ADMIN_TOKEN` first, else `AGENTICFORM_TOKEN` — and never accept the token as an argument.

```bash
af nodes
af token issue ci-agent
af run start --key job-1 --harness codex --prompt "Fix the failing tests"
af run get <runId>
af run events <runId> --follow
af run cancel <runId>
af run permissions <runId>
af run answer <runId> <requestId> allow
```

### Caller tokens

Calling agents, scripts, and MCP clients do not use the admin token. The admin issues scoped caller tokens (`runs` scope) using `af token issue <name>` (or `POST /v1/tokens`). Callers set `AGENTICFORM_TOKEN` with the issued `afc_<id>_<secret>` string:

```bash
# As admin: manage caller tokens
af token issue ci-agent
af token list
af token revoke <tokenId>
```

A `runs` token can submit runs, inspect runs, stream events via SSE, cancel runs, list nodes, and view pending permissions. Administrative actions (node management, issuing/revoking tokens, answering permissions, recovering runs) require the admin token; calls with a `runs` token return `403 forbidden`. When a token is revoked, authentication fails on the next request, and active SSE event streams close within 30 s.

### Remote permission answers

By default a hub run allows permission requests, since the node's sandbox is the boundary. A run started with `--permissions ask` (CLI), `permissionPolicy: "ask"` (API, MCP) or the UI's Permissions selector makes the node report each request and wait for an answer; remote answers apply only to those runs. Deny on silence remains enforced by the runtime's 300 s timeout. `--permissions deny` refuses every request. The owner can inspect pending requests and answer them remotely via the CLI, MCP, or the operator UI:

```bash
af run permissions <runId>
af run answer <runId> <requestId> allow   # or deny
```

Only the admin token can answer permission requests; calling agents holding a caller token can view pending requests but cannot answer (`403 forbidden`).

### Run lineage and depth limits

Runs can form parent-child lineages by passing `--parent <runId>` when starting a run (`parentRunId` on `POST /v1/runs` or MCP `start_run`). The hub tracks execution depth (`depth = parent.depth + 1`, with root runs at `depth: 0`).

```bash
af run start --key subtask-1 --harness codex --prompt "Investigate failure" --parent <parentRunId>
```

To prevent runaway recursive agent cascades, `AGENTICFORM_RUN_MAX_DEPTH` (default `3`) limits the maximum tree depth. Submissions past this limit fail with `422 depth_exceeded` without inserting a row. An invalid parent ID returns `404 parent_not_found`.

## Configuration

Every environment variable below is read by at least one package. Empty defaults mean the feature is off until set. Secrets are marked; never put a real value in a file that is committed.

| Variable | Package | Default | Meaning |
|---|---|---|---|
| `AGENTICFORM_ADMIN_TOKEN` | hub, cli, mcp | none (required for hub) | Secret. Admin bearer token; the hub refuses to start below 32 characters. The CLI and MCP prefer it over `AGENTICFORM_TOKEN` |
| `AGENTICFORM_TOKEN` | cli, mcp | none | Secret. Caller bearer token, typically a hub-issued `afc_<id>_<secret>` `runs` token. Used when `AGENTICFORM_ADMIN_TOKEN` is unset; never accepted as an argument |
| `AGENTICFORM_RUN_MAX_DEPTH` | hub | `3` | Deepest `parentRunId` chain allowed; a child past it is `422 depth_exceeded` |
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
| `AGENTICFORM_REAL_HARNESS` | tests (node) | unset (skipped) | Opt-in: set to `1` to run tests that spawn or probe a real installed harness CLI; an absent harness still skips |
| `AGENTICFORM_CONFORMANCE_CWD` | runtime | process cwd | Working directory given to the conformance harness |

## Memory

Idle resident memory, measured 2026-11-18 on the development host (2 vCPU /
7.6 GB, not pinned):
`hub` 25.7 MB, `node` 44.4 MB. Method: start each process alone with a temporary
state directory, wait two seconds after it reports ready, then read `VmRSS` from
`/proc/<pid>/status`. The node is higher because it loads `runtime` and the ACP
driver. These are idle figures; a run adds the harness process.

## Claude Code config directory

The node runs `claude` with `CLAUDE_CONFIG_DIR=/home/agent/.claude` inside the
sandbox, so `.claude.json` and `.credentials.json` live in the bound `~/.claude`
directory instead of the home root. The value is a fixed catalog constant, never
run input or the node's environment.

To make your interactive `claude` read the same file, migrate once:

1. Stop any running `claude`.
2. `mv ~/.claude.json ~/.claude/.claude.json` (keep a copy if unsure).
3. `export CLAUDE_CONFIG_DIR=~/.claude` in your shell profile.

Skipping it does not break runs; the two harnesses then keep separate files and
trust and MCP edits stop crossing over. A config directory the node cannot read,
write and traverse is reported as `state_dir_unusable` and a run for `claude`
fails with `harness_unavailable` before any child starts. Linux only: on macOS
credentials stay in the keychain and the config directory is not claimed to
carry them.

## Isolation cost

Measured 2026-11-18 on a 2 vCPU / 7.6 GB host, pinned to one CPU with `taskset`,
bubblewrap 0.9.0, serially: the startup self-test takes 69 ms (median of three;
66-79 ms) and one probe of `opencode` takes 3.6 s (median of three; 3.6-4.2 s).
Method: call
`selfTest()` and `probeHarness()` from `packages/node` three times each and time
each call with `performance.now()`. The probe includes the sandbox spawn and the
ACP `initialize` and `session/new` handshake, so most of it is the harness's own
startup. A probe runs at most one at a time and never blocks a heartbeat.

## Documentation

- [Architecture](docs/architecture.md)
- [Supported harnesses](docs/harnesses.md)
- [Release evidence](docs/release-evidence.md)
- [Constitution](.specify/memory/constitution.md)
- [Node/hub invariants](docs/node-hub-invariants.md)
- [Runtime spec](specs/001-runtime-foundation/spec.md)
- [Node and hub spec](specs/002-node-hub/spec.md)
- [Harness isolation spec](specs/003-harness-isolation/spec.md)
- Soak test runner: [`scripts/soak.ts`](scripts/soak.ts)
- Node packaging test: [`scripts/package-node.ts`](scripts/package-node.ts)

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

Tests that spawn a harness CLI you installed (claude, opencode) are skipped by default. To run them:

```bash
AGENTICFORM_REAL_HARNESS=1 bun test packages
```

## License

MIT, see [LICENSE](LICENSE).
