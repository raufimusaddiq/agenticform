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

### Durable workflows (Psychoscript)

Callers and agents can also run confined JavaScript workflows ("code mode") locally via `@agenticform/script` (`af script`) or durably on the hub (`POST /v1/workflows`, `af workflow`, or MCP `start_workflow`):

```bash
af workflow start --key wf-1 --code 'const r = await af.run({ harness: "codex", prompt: "Fix tests" }); return r.status'
af workflow get <workflowId>
af workflow list
af workflow cancel <workflowId>

# Or run/resume locally on the caller side without hub workflow storage:
af script run --code 'return await af.listNodes()' --state-out wf.snap
af script resume --state wf.snap
```

Scripts run inside a Psychoscript bytecode VM with no ambient filesystem, network, timers, or `eval`, exposing only `af.run`, `af.startRun`, `af.getRun`, `af.cancelRun`, `af.listNodes`, `af.listEvents`, and `af.listPermissions`. When a hub workflow awaits `af.run(...)`, the hub suspends its VM snapshot to SQLite (`snapshot_bytes`) and resumes it automatically once child runs reach a terminal state, including across hub restarts.

## Configuration

For everyday use, configure once through `af` (`~/.config/agenticform/config.json`, mode `0600`) instead of managing dozens of environment variables:

```bash
af init hub --port 8787
printf '%s\n' "$TOKEN" | af init client --url https://hub.example.com
af init node --url https://hub.example.com --harnesses codex,claude --slots 2
af config show   # prints effective values and source (env/file/default), with secrets redacted
```

Environment variables override the config file (`env > config.json > identity.json > default`). For containers, systemd, and CI, you normally only need:

| Variable | Package | Meaning |
|---|---|---|
| `AGENTICFORM_CONFIG` | all | Override config file path (defaults to `~/.config/agenticform/config.json`) |
| `AGENTICFORM_HUB_URL` | hub, node, cli, mcp | Hub origin (`https://` required for non-loopback hosts; enrolled nodes also remember this in `identity`) |
| `AGENTICFORM_ADMIN_TOKEN` | hub, cli, mcp | Secret. Admin bearer token (≥32 chars in hub) |
| `AGENTICFORM_TOKEN` | cli, mcp | Secret. Scoped `runs` caller token (`afc_<id>_<secret>`) |
| `AGENTICFORM_ENROLL_TOKEN` | node (`enroll`) | Secret. Single-use enrollment token issued by the hub |

All 15 `config.json` keys and the full advanced-tuning env reference live in [docs/configuration.md](docs/configuration.md).

## Memory

Idle resident memory, measured 2026-11-18 on the development host (2 vCPU /
7.6 GB, not pinned):
`hub` 25.7 MB, `node` 44.4 MB. Method: start each process alone with a temporary
state directory, wait two seconds after it reports ready, then read `VmRSS` from
`/proc/<pid>/status`. The node is higher because it loads `runtime` and the ACP
driver. These are idle figures; a run adds the harness process.
After a 4-hour soak (16,160 runs, 3 node restarts) the node held about 90 MB with
no growth (-1.2%); see [Release evidence](docs/release-evidence.md).

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
- [Configuration](docs/configuration.md)
- [Supported harnesses](docs/harnesses.md)
- [Release evidence](docs/release-evidence.md)
- [Constitution](.specify/memory/constitution.md)
- [Node/hub invariants](docs/node-hub-invariants.md)
- [Runtime spec](specs/001-runtime-foundation/spec.md)
- [Node and hub spec](specs/002-node-hub/spec.md)
- [Harness isolation spec](specs/003-harness-isolation/spec.md)
- [Psychoscript workflows spec](specs/005-psychoscript-workflows/spec.md)
- [Unified CLI config spec](specs/006-cli-config/spec.md)
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
