# Agenticform

Agenticform is a small execution fabric for coding agents. It gives applications, scripts and other agents one way to run Claude Code, Codex, OpenCode, omp, Pi, DeepSeek Harness and similar tools.

> **Status:** early. The local `runtime` package, the `node` daemon and the `hub` exist. The earlier Java and Go stack is still in `server/` and `node/`, documented in [docs/legacy](docs/legacy/README.md).

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

## Packages

| Package | Purpose | Status |
|---|---|---|
| `runtime` | Local runs, ACP driver, events, capabilities | Available |
| `node` | Daemon on each machine, isolation, recovery | Available |
| `hub` | Connection point, placement, fencing, HTTP API | Available |
| `client` | TypeScript SDK for the HTTP API | Available |
| CLI, MCP | Thin clients of the HTTP API | Available |

## Hub configuration

The hub reads its configuration from the environment and refuses to start on unsafe values: the admin token must be at least 32 characters, and a non-local public URL must be HTTPS and a clean origin.

The hub also serves a small operator UI at `/` from the same origin. It asks for the admin token in the browser, keeps it in `sessionStorage`, and sends it only in the `Authorization` header; the token never appears in a URL, the page, or a log.

The CLI (`af`) and the MCP server (`agenticform-mcp`) are thin clients of the same API. Both read `AGENTICFORM_HUB_URL` and `AGENTICFORM_ADMIN_TOKEN` from the environment and never accept the token as an argument.

```bash
af nodes
af run start --key job-1 --harness codex --prompt "Fix the failing tests"
af run get <runId>
af run events <runId> --follow
af run cancel <runId>
```

| Variable | Default | Purpose |
|---|---|---|
| `AGENTICFORM_ADMIN_TOKEN` | none (required) | Bearer token for caller and operator routes |
| `AGENTICFORM_HUB_URL` | none | Public origin; non-local values must be HTTPS |
| `AGENTICFORM_STATE_DIR` | `$HOME/.agenticform-hub` | Directory for the SQLite database |
| `AGENTICFORM_HUB_DB` | `$AGENTICFORM_STATE_DIR/hub.sqlite` | Explicit database path |
| `AGENTICFORM_HUB_PORT` | `8787` | Listen port |
| `AGENTICFORM_HEARTBEAT_SECONDS` | `15` | Heartbeat interval advertised to nodes |
| `AGENTICFORM_NODE_OFFLINE_SECONDS` | `45` | Silence before a node is `OFFLINE` |
| `AGENTICFORM_ENROLLMENT_TTL_SECONDS` | `600` | Enrollment token lifetime |
| `AGENTICFORM_NONCE_TTL_SECONDS` | `600` | Signed-request nonce lifetime |
| `AGENTICFORM_NONCE_CLEANUP_SECONDS` | `600` | Nonce cleanup interval |
| `AGENTICFORM_LEASE_SECONDS` | `900` | Command lease length |
| `AGENTICFORM_CLOCK_SKEW_SECONDS` | `120` | Allowed signed-request clock skew |
| `AGENTICFORM_RECOVERY_GRACE_SECONDS` | `120` | Wait before a disconnected run may recover |
| `AGENTICFORM_POLL_MS` | `1500` | Empty-poll backoff advertised to nodes |
| `AGENTICFORM_MAX_BODY_BYTES` | `1048576` | Maximum request body size before `413 payload_too_large` |

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
- [Legacy documentation](docs/legacy/README.md)

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
