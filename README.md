# Agenticform

Agenticform is a small execution fabric for coding agents. It gives applications, scripts and other agents one way to run Claude Code, Codex, OpenCode, omp, Pi, DeepSeek Harness and similar tools.

> **Status:** early. The local `runtime` package exists. Running work across machines is the next milestone. The earlier Java and Go stack is still in `server/` and `node/`, documented in [docs/legacy](docs/legacy/README.md).

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
```

## Packages

| Package | Purpose | Status |
|---|---|---|
| `runtime` | Local runs, ACP driver, events, capabilities | Available |
| `node` | Daemon on each machine, isolation, recovery | Planned |
| `hub` | Connection point, placement, fencing, HTTP API | Planned |
| `client` | TypeScript SDK for the HTTP API | Planned |
| CLI, MCP | Thin clients of the HTTP API | Planned |

## Documentation

- [Architecture](docs/architecture.md)
- [Supported harnesses](docs/harnesses.md)
- [Constitution](.specify/memory/constitution.md)
- [Current spec](specs/001-runtime-foundation/spec.md)
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
