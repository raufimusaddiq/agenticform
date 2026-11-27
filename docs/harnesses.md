# Supported Harnesses

You install, update and log in to each harness yourself. Agenticform starts it and reports a named error when it is missing or not logged in.

A harness counts as **tested** only after the conformance suite passes against a recorded version. Only `opencode` has reached that level, with 2.3.2. Against a real harness the suite runs two cases, the handshake and one prompt; the scripted cases (cancel, permissions, process death, capability refusal) run only against the fake agent.

| Id | Harness | Profile | Entry point | Level | Notes |
|---|---|---|---|---|---|
| `claude` | Claude Code | coding | `claude-agent-acp` 0.113.0 | documented | One real prompt completed on 2026-11-05 with 0.100.0; not re-run on 0.113.0. Starts sessions in auto permission mode, see [Permission mode](#claude-permission-mode) |
| `codex` | Codex | coding | `codex-acp` 2.12.1 | documented | Handshake and `auth_required` seen on 2026-11-05 with 2.5.0; not re-run on 2.12.1; no prompt run |
| `opencode` | OpenCode | coding | `opencode acp` | tested | On 2026-11-27 with 2.3.2 on WSL Ubuntu and ACP SDK 2.12.0: the conformance suite, the sandboxed probe and one sandboxed hub run passed. Other versions are not covered |
| `omp` | Oh My Pi | coding | `omp acp` | documented | Not run; confirm the command on your version |
| `pi` | Pi | coding | `pi-acp` 0.0.35 | documented | Not run; early third-party adapter. `pi --mode rpc` is a possible direct driver |
| `dsh` | DeepSeek Harness | coding | `dsh --profile acp` | documented | Not run; developer preview. MCP session support unconfirmed |
| `hermes` | Hermes Agent | agentic | `hermes acp` | documented | Not run; needs the ACP extra |
| `openclaw` | OpenClaw | agentic | `openclaw acp` | documented | Not run; Gateway-backed with partial ACP features |

OpenBot has no documented ACP mode. It would need its own driver, and more than one project uses the name.

## How the node sees a harness

The node probes each configured harness at startup and after its probe cache
expires: 300 s for a non-ready result, 1 h for a `ready` one. A probe resolves
the entry point without network access, then runs an ACP `initialize` and
`session/new` inside the sandbox. It never installs, updates or authenticates a
harness, and it reads no credential file. A harness that completes the handshake while logged out can declare an auth check (see below). A `bunx` harness runs the cached package
bin directly with `bun`, so it needs no registry lookup. If `/etc/resolv.conf` is a
symlink to a regular file outside `/etc` and `/run` (as on WSL), the node binds that
file read-only so the harness can resolve model hosts.

Each probe creates one empty harness session, so a harness's own state directory
(for example `~/.claude`) gains one session per harness per TTL. The probe sends
no prompt and makes no tool call.

| Status | Meaning | Advertised |
|---|---|---|
| `ready` | The entry point resolved and the sandboxed handshake completed | yes |
| `missing` | The entry point is absent (`not_installed`) or the pinned `bunx` version is not cached (`version_not_cached`) | no |
| `unauthenticated` | The harness answered `auth_required`, or its declared auth check reported `loggedIn: false` | no |
| `unknown` | The probe timed out, the process exited before the handshake, or a declared state directory is unusable (`state_dir_unusable`), or a declared auth check could not run or gave no clear answer (`auth_check_failed`) | no |

The heartbeat advertises only `ready` harnesses and reports every configured
harness with its status and reason. A run for a non-ready harness fails with
`harness_missing`, `harness_unauthenticated` or `harness_unavailable` before any
child starts. A failed run invalidates that harness's cache entry, so a login is
picked up on a later heartbeat without a restart.

Probes run one at a time and never block a heartbeat: the heartbeat reports the
last known status and a fresh result lands on a later beat. A probe's stderr is
discarded and its output is reduced to a status and a reason code, so no raw
harness output, path or credential reaches the heartbeat or hub storage.

## Auth check

Some harnesses finish `initialize` and `session/new` without credentials and only
fail at the first prompt. For those, the catalog declares an `authCheck`: the
harness's own status command (command, args and the JSON boolean to read). After a
successful handshake the node runs it as a child inside the same sandbox and
profile a run uses (same state binds, config dir and env allowlist). The node never
opens a credential file; the harness reads its own. Only stdout is read, parsed
strictly as a JSON object with a boolean field, reduced to that boolean and
dropped. Stderr is never connected, and no output reaches events, the heartbeat,
logs or the hub. The exit code is ignored. The check is bounded by the probe timeout
and shares the probe's cache and single-flight.

| Result | Report |
|---|---|
| `loggedIn: true` | `ready` |
| `loggedIn: false` | `unauthenticated` / `auth_required` |
| Binary absent in the sandbox, timeout, non-JSON, missing or non-boolean field, over 64 KiB | `unknown` / `auth_check_failed` |

For `claude` the command is `claude auth status`, run from the CLI that
`claude-agent-acp` bundles in its cached package (`node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude`), which is already inside the bound entry
directory, so no bind is widened. A run that fails at its first prompt with
"Authentication required" invalidates the entry, and the next heartbeat re-probes
and reports `unauthenticated`.

### Logged-out behaviour per harness

Gap: `session/new` succeeds while logged out, so the handshake alone reports `ready`.
Tested with a temporary `HOME` holding empty state, never the real config dirs.

| Harness | Gap | Auth check | Evidence |
|---|---|---|---|
| `claude` | yes | yes (`claude auth status`) | tested on WSL, claude-agent-acp 0.100.0 (CLI 2.1.328); not re-run on 0.113.0: `session/new` succeeds, the first prompt fails; `auth status` prints `loggedIn: false` |
| `codex` | no | no | tested on WSL, codex-acp 2.5.0 (codex-cli 0.159.0); not re-run on 2.12.1: `session/new` fails with "Authentication required" (`-32000`) |
| `opencode` | no (built-in free models) | no | tested on WSL, opencode 1.19.6: `session/new` succeeds logged out and lists free models; a paid provider that is not configured fails at the prompt. `opencode auth list` reports providers, not a login boolean, so no check is declared |
| `pi` | no | no | documentation only: pi-acp 0.0.34 source (not re-read on 0.0.35) returns `auth_required` from `session/new` when no model is available; `pi` itself not installed |
| `omp` | unknown | no | documentation only; not installed on WSL |
| `dsh` | unknown | no | documentation only; not installed on WSL |
| `hermes` | unknown | no | documentation only; not installed on WSL |
| `openclaw` | unknown | no | documentation only; not installed on WSL |

Limit: for a harness marked gap `unknown` or with no boolean status command, a
logged-out harness can still be reported `ready` and fail at its first prompt.
That failure is `agent_error`, and the entry is invalidated as for any failed run.
Add an `authCheck` to the catalog row once the harness has such a command; no
code change is needed.

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
the directory named by a profile `env` value is checked, and that value must
name one of the profile's own writable state directories; another `rw` state
directory is created and bound as before, with no new refusal.

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

## Updating pinned versions

Use this for the ACP SDK (`packages/runtime/package.json`), the `bunx` adapters (`packages/runtime/src/harnesses.ts`) and any other pin. Bun is pinned twice, in `package.json` (`packageManager`) and `.github/workflows/ci.yml` (`bun-version`); keep them equal.

1. Compare each pin with `npm view <package> dist-tags`. Take `latest`, never `preview` or `beta`, and keep exact versions. ACP protocol v2 is a separate decision.
2. For `claude-agent-acp`, confirm the `authCheck.bin` packages still exist: read its `@anthropic-ai/claude-agent-sdk` version with `npm view <package>@<version> dependencies`, then that version's `optionalDependencies`.
3. Change the pins, run `bun install`, and commit `bun.lock` with them.
4. Verify on Ubuntu (WSL is fine) with `bwrap`, in a checkout on the Linux filesystem. Windows results do not count, because the tests assume POSIX.

   ```bash
   bun install --frozen-lockfile
   bun run typecheck
   bun test packages
   bun scripts/package-node.ts
   ```

5. Only when the owner asks, run the real-harness checks: `AGENTICFORM_REAL_HARNESS=1`, and the paid suite with `AGENTICFORM_CONFORMANCE_HARNESS=<id>`.
6. Update the tables in this file. Write "not re-run on `<version>`" unless you ran it, and keep old evidence tied to the version that produced it.
7. Tell operators in the PR that each node must cache the new adapter version, or it reports `missing` / `version_not_cached`.

## Real-harness checks

A default `bun test packages` never starts a real harness. Tests that probe an installed harness CLI (the sandboxed claude and opencode handshakes in `packages/node/test/probe.test.ts`) run only with `AGENTICFORM_REAL_HARNESS=1`, and still skip a harness that is not installed. The skip reason names the flag. This is separate from `AGENTICFORM_CONFORMANCE_HARNESS`, which selects the harness for the paid conformance suite. CI must not set `AGENTICFORM_REAL_HARNESS`.

## `claude` permission mode

Since `claude-agent-acp` 0.101, sessions start in Claude Code's `auto` permission mode, where Claude Code's classifier decides which actions need a `session/request_permission`. This is consistent with principle IV of the constitution (2.0.0): the node sandbox is the safety boundary, and a native auto mode agrees with the `allow` default. Requests that Claude Code does send follow the run's permission policy as usual. The runtime does not change the session mode.
