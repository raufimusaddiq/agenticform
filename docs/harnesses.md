# Supported Harnesses

You install, update and log in to each harness yourself. Agenticform starts it and reports a named error when it is missing or not logged in.

A harness counts as **tested** only after the conformance suite passes against a recorded version. No harness has reached that level yet.

| Id | Harness | Profile | Entry point | Level | Notes |
|---|---|---|---|---|---|
| `claude` | Claude Code | coding | `claude-agent-acp` 0.100.0 | documented | One real prompt completed on 2026-11-05 |
| `codex` | Codex | coding | `codex-acp` 2.5.0 | documented | Handshake and `auth_required` seen on 2026-11-05; no prompt run |
| `opencode` | OpenCode | coding | `opencode acp` | documented | Not run |
| `omp` | Oh My Pi | coding | `omp acp` | documented | Not run; confirm the command on your version |
| `pi` | Pi | coding | `pi-acp` 0.0.34 | documented | Not run; early third-party adapter. `pi --mode rpc` is a possible direct driver |
| `dsh` | DeepSeek Harness | coding | `dsh --profile acp` | documented | Not run; developer preview. MCP session support unconfirmed |
| `hermes` | Hermes Agent | agentic | `hermes acp` | documented | Not run; needs the ACP extra |
| `openclaw` | OpenClaw | agentic | `openclaw acp` | documented | Not run; Gateway-backed with partial ACP features |

OpenBot has no documented ACP mode. It would need its own driver, and more than one project uses the name.

## How the node sees a harness

The node probes each configured harness at startup and after its probe cache
expires: 300 s for a non-ready result, 1 h for a `ready` one. A probe resolves
the entry point without network access, then runs an ACP `initialize` and
`session/new` inside the sandbox. It never installs, updates or authenticates a
harness, and it reads no credential file.

Each probe creates one empty harness session, so a harness's own state directory
(for example `~/.claude`) gains one session per harness per TTL. The probe sends
no prompt and makes no tool call.

| Status | Meaning | Advertised |
|---|---|---|
| `ready` | The entry point resolved and the sandboxed handshake completed | yes |
| `missing` | The entry point is absent (`not_installed`) or the pinned `bunx` version is not cached (`version_not_cached`) | no |
| `unauthenticated` | The harness answered `auth_required` | no |
| `unknown` | The probe timed out, the process exited before the handshake, or a declared state directory is unusable (`state_dir_unusable`) | no |

The heartbeat advertises only `ready` harnesses and reports every configured
harness with its status and reason. A run for a non-ready harness fails with
`harness_missing`, `harness_unauthenticated` or `harness_unavailable` before any
child starts. A failed run invalidates that harness's cache entry, so a login is
picked up on a later heartbeat without a restart.

Probes run one at a time and never block a heartbeat: the heartbeat reports the
last known status and a fresh result lands on a later beat. A probe's stderr is
discarded and its output is reduced to a status and a reason code, so no raw
harness output, path or credential reaches the heartbeat or hub storage.

## Isolation limit

The sandbox covers the local harness child: its filesystem writes, its
environment and its process group. A gateway-backed harness may run tools through
its own service, outside that child, so those tools are not covered by the local
sandbox and are not claimed equal to a coding harness. The node still reports the
harness's presence and authentication truthfully.

## `claude` config directory

[CC] keeps `.claude.json` and `.credentials.json` at the home root unless
`CLAUDE_CONFIG_DIR` is set. The node's `claude` profile sets it to
`/home/agent/.claude` inside the sandbox, the same directory the profile already
binds, so one directory bind covers config, credentials and state. The value is a
fixed catalog constant: it never comes from the run request, the host path or the
node's environment, so every run sees the same file.

Before the sandbox is built the node creates a missing directory `0700` and
checks that it is a directory the node user can read, write and traverse. An
unusable directory is `unknown` with reason `state_dir_unusable`: the harness is
not advertised and a run fails with `harness_unavailable`, because [CC] exits 0
and silently starts with an empty config when its directory is unusable. Only
the directory named by a profile `env` value is checked; another `rw` state
directory is created and bound as before.

Operator migration, once, so the interactive harness and the sandboxed one read
the same file:

1. Stop any running `claude`.
2. `mv ~/.claude.json ~/.claude/.claude.json` (keep a copy if unsure).
3. `export CLAUDE_CONFIG_DIR=~/.claude` in your shell profile.

The node never moves or edits operator files. Skipping the migration does not
break runs: the sandboxed harness writes `~/.claude/.claude.json` while the
interactive one keeps `~/.claude.json`, so the two fork and trust and MCP edits
stop crossing over.

Linux only: on macOS [CC] keeps credentials in the keychain, and the
`sandbox-exec` shape is unverified, so the config directory is not claimed to
carry credentials there.

## Custom harnesses

Pass a definition instead of an id. Any command that speaks ACP v1 over stdio works.

```ts
runtime.run({
  harness: { id: "mine", profile: "coding", command: "my-agent", args: ["acp"] },
  cwd,
  prompt,
})
```

## Upgrading a harness

1. Change the pinned version in `packages/runtime/src/harnesses.ts`.
2. Run `AGENTICFORM_CONFORMANCE_HARNESS=<id> bun test packages`.
3. Update this table.
