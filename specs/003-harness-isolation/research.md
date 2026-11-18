# Research: Harness Isolation and Presence

Checked on 2026-11-18 on the development host (Linux 6.8.0, 2 vCPU / 7.6 GB, no
root); the node is designed for a 1 CPU / 2 GB host.
This is a design record, not a claim about shipped code. The binding behaviour is
in [spec.md](spec.md); this file records what the host can actually do and the
smallest choice that satisfies it.

## Host probe

| Check | Result | Consequence |
|---|---|---|
| `bwrap --version` | bubblewrap 0.9.0 at `/usr/bin/bwrap`, not setuid | Usable only if unprivileged user namespaces are permitted for it |
| `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all true` | exit 0 | The full sandbox shape works on this host |
| `bwrap --ro-bind / / --bind <ws> <ws> ... sh -c 'touch <ws>/ok; touch /tmp/outside'` | workspace write ok, outside write `Read-only file system` | The write-denial guarantee is real, not theoretical |
| `unshare -Ur true` | `write failed /proc/self/uid_map: Operation not permitted` | Raw user namespaces are blocked for this user |
| `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` | `1` | Explains the block: AppArmor restricts unprivileged userns |
| `bwrap` under that restriction | works | bubblewrap carries an AppArmor profile that permits it; do not assume `unshare` works just because `bwrap` does |
| Landlock in `/sys/kernel/security/lsm` | present | Kernel supports it |
| Landlock ABI via `syscall(444, 0, 0, 1)` | `4` | ABI 4: filesystem rules, no network rules |
| `firejail` | absent | Not a candidate |
| `systemd-run` | present | Needs a user session bus; not guaranteed on a node, not a candidate |

The important finding: **presence of a binary is not proof**. `unshare` exists and
fails; `bwrap` exists and works. The node must self-test the exact shape it will
use, not `command -v`.

## Decisions

| Area | Decision | Rejected alternative |
|---|---|---|
| Primitive | bubblewrap on Linux, invoked as a wrapper around the harness command | Landlock: ABI 4 is present, but there is no stdlib binding in Bun/Node, so it needs a native addon or a helper binary — a dependency for a capability bwrap already provides |
| Fallback | none; fail closed with `isolation_unavailable` | `unshare` + manual mounts: blocked on this host and more code to get wrong |
| macOS | `sandbox-exec` profile, same profile table, documented as best-effort | Claiming parity: seatbelt is deprecated and its guarantees differ |
| Detection | self-test the exact argv at startup, then per run | `command -v bwrap`: proves nothing, as `unshare` shows |
| Mount shape | minimal read-only system binds, private tmpfs home, workspace bind, declared state binds | `--ro-bind / /`: exposes `~/.ssh` and every other project to reads |
| Workspace mode | `write` or `read-only` per run, default `write` | A single global mode: read-only review runs are a real second user |
| Network | not unshared | `--unshare-all`: harnesses cannot reach their model |
| Environment | `--clearenv` plus an allowlist | inheriting `process.env`: leaks the hub token into the harness |
| Harness presence | ACP `initialize` + `session/new` probe inside the sandbox | reading credential files: fragile, and it reads secrets |
| Probe cache | TTL 300 s non-ready, 1 h ready; re-probe after a failed run | probing every heartbeat: 8 harnesses × 15 s is wasteful on a 1 CPU node |
| Heartbeat shape | additive `harnessReport` and `isolation` fields, `harnesses` keeps meaning "ready" | a protocol version bump: additive optional fields do not need one |

## Sandbox shape

The node builds one argv and hands it to `runtime` as a harness definition
override (`command: "bwrap"`, `args: [...sandbox, "--", harness.command, ...]`).
`runtime` is unchanged: it still spawns one child, detached, in its own process
group.

```text
bwrap
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
  --die-with-parent --new-session --cap-drop ALL
  --clearenv
  --setenv PATH /usr/local/bin:/usr/bin:/bin
  --setenv HOME /home/agent
  --ro-bind /usr /usr          (and /bin, /sbin, /lib, /lib64, /opt when present)
  --ro-bind /etc /etc
  --ro-bind /run /run          (when present; nss and resolver state)
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --tmpfs /home/agent
  --bind <workspace> <workspace>        (or --ro-bind for read-only)
  --bind <state-dir> <state-dir>        (per profile, read-write)
  --ro-bind <state-dir> <state-dir>     (per profile, read-only)
  -- <harness.command> <harness.args...>
```

`--unshare-cgroup-try` rather than `--unshare-cgroup`: the latter fails on some
kernels without a cgroup namespace, and a failed sandbox must not be confused
with an unavailable one. `--unshare-net` is deliberately absent.

## Per-harness mount table

Verified on 2026-11-18 against each harness's documentation and, where the
harness is installed on the verification host, a real run. A wrong entry is a
table bug, fixed by editing the table and re-running the conformance probe, never
by widening the mount for everyone.

| Harness | Read-write | Read-only | Evidence |
|---|---|---|---|
| `claude` | `~/.claude` | — | Claude Code 2.1.327: `~/.claude` holds credentials, history and cache; the CLI starts in the sandbox with it bound. The profile also sets `CLAUDE_CONFIG_DIR=/home/agent/.claude`, which moves `.claude.json` and `.credentials.json` into that directory (see [Harness config directory](#harness-config-directory)). There is no `~/.config/claude`. |
| `codex` | `~/.codex` | — | Docs: user config is `~/.codex/config.toml`, with profile files and logs beside it. The directory exists here; the CLI is not installed, so no run. |
| `opencode` | `~/.local/share/opencode` | `~/.config/opencode` | OpenCode 2.3.0: a real `opencode acp` run writes its log and database under the data dir; with that dir read-only the run fails. The docs put global config in `~/.config/opencode`. |
| `omp` | `~/.omp` | — | Not installed; entry from upstream docs, unverified. |
| `pi` | `~/.pi` | — | Not installed; entry from upstream docs, unverified. |
| `dsh` | `~/.dsh` | — | Not installed; entry from upstream docs, unverified. |
| `hermes` | `~/.hermes` | — | `~/.hermes` exists (skills only); the CLI is not installed, so no run. |
| `openclaw` | `~/.openclaw` | — | Not installed; entry from upstream docs, unverified. |
| custom / unknown | none | none | Test: empty home, workspace only. |

Paths are resolved against the node user's home before binding. A path that does
not exist is created `0700` for read-write entries and skipped for read-only
entries, so a missing optional config directory does not fail the run.

### Verification findings

- **The entry point is not a state mount.** The sandbox root is a fresh tmpfs, so
  a harness installed under the home (`~/.local/bin/claude`,
  `~/.opencode/bin/opencode`, `~/.bun/bin/bunx`) is not visible, and the fixed
  `PATH` does not include those directories. A real run needs the resolved entry
  point's directory bound read-only. That is entry-point resolution, not a state
  mount, and it is not part of this table.
- **`~/.claude.json` is a file at the home root.** Claude Code writes it for
  account details and MCP configuration. The profile binds directories only, so a
  run gets a fresh file. Resolved by setting `CLAUDE_CONFIG_DIR` to the bound
  `~/.claude`; see [Harness config directory](#harness-config-directory).
- **`~/.config/claude` does not exist.** It was removed from the table; the docs
  and the host agree that Claude Code uses `~/.claude`.

## Harness config directory

Checked on 2026-11-18 against Claude Code 2.1.327 on this host, with a temporary
`HOME` and a temporary `CLAUDE_CONFIG_DIR`; the operator's `~/.claude` and
`~/.claude.json` were not read or written.

| Check | Result | Consequence |
|---|---|---|
| `CLAUDE_CONFIG_DIR` unset | config dir `$HOME/.claude`; `.claude.json` at `$HOME/.claude.json`; credentials at `$HOME/.claude/.credentials.json` | The home-root file is outside every directory bind |
| `CLAUDE_CONFIG_DIR=<dir>` | `.claude.json` at `<dir>/.claude.json`; credentials at `<dir>/.credentials.json`; nothing written under `$HOME` | One directory bind covers config, credentials and state |
| `$HOME/.claude.json` present while `CLAUDE_CONFIG_DIR` is set | never opened (0 accesses in `strace`) | No fork between the two files; the home-root file is ignored |
| `<dir>` missing | created, `.claude.json` written | A missing dir is not an error; the node still creates it `0700` first |
| `<dir>` mode `000` | exit 0, no file written, no error | Silent empty config: the node must pre-check, not trust the exit status |
| `CLAUDE_CONFIG_DIR=relative/cfg` | resolved against the process cwd | Relative values are ambiguous; the profile must require absolute |
| file bind + rename | `mv: Device or resource busy` | A file bind for `.claude.json` is not viable |
| full sandbox: private home, `--clearenv`, `--bind <dir> /home/agent/.claude`, `CLAUDE_CONFIG_DIR=/home/agent/.claude` | `claude mcp list` read the sentinel MCP server and wrote `backups/` and `telemetry/` back to the host dir | The shape works end to end |

### Migration

The operator's interactive harness and the sandboxed harness must read the same
file, or trust and MCP configuration fork. The smallest migration:

1. Stop any running `claude`.
2. `mv ~/.claude.json ~/.claude/.claude.json` (keep a copy if unsure).
3. `export CLAUDE_CONFIG_DIR=~/.claude` in the operator's shell profile.

Then both read `~/.claude/.claude.json` and `~/.claude/.credentials.json`, and
the node's `~/.claude` bind covers everything. The node never moves or edits
operator files; a node that finds no `.claude.json` starts from a fresh one, as
it does today.

Rejected alternatives:

| Option | Why not |
|---|---|
| Bind `~/.claude.json` as a file | Claude Code writes by rename; the rename fails with `EBUSY` |
| Symlink `~/.claude/.claude.json` → `~/.claude.json` | The target is outside the bind, so the link dangles inside the sandbox |
| A separate config dir for the node | Two files diverge; trust and MCP edits in one are invisible to the other |
| Copy the file in and out per run | A sync problem with a write window, and it duplicates credentials |

### Other harnesses

| Harness | Home-root file? | Action |
|---|---|---|
| `codex` | no; `CODEX_HOME` defaults to `~/.codex`, a directory | none; already a state bind |
| `opencode` | no; XDG data and config directories | none; already state binds |
| `omp`, `pi`, `dsh`, `hermes`, `openclaw` | not installed here; documented as directory state | none until a real run shows a home-root file |

The mechanism is generic: a harness that grows a home-root file is a table row
with an `env` entry, not new code.

### Fail closed

- A profile `env` value that is not absolute, or that names a path with no
  matching state entry, is a table error: the node refuses that harness.
- A config directory that cannot be created, is not a directory, or is not
  readable and writable by the node user is `state_dir_unusable`: the harness is
  `unknown` and a run fails with `harness_unavailable`. The node does not rely on
  the harness's exit status, which is 0 with an empty config.
- The env allowlist stays fixed. The only addition is the profile's own constant;
  no run input, host path or node variable can add one.

## Entry-point install roots

A directory under HOME may be bound whole only when it is inside a declared
state dir (mapped to the sandbox home) or one of the install roots below.
Anything else under HOME binds only the resolved entry file and its interpreter,
so a subdirectory such as `~/.ssh/sub` or `~/.config/gh` cannot leak siblings.

Two kinds of data:

**Bin dirs** are bound as-is (the dir itself, read-only, on `PATH`), only when
they exist:

| Bin dir | Why |
|---|---|
| `~/.local/bin` | User-local executables; the common install target for `claude` and other CLIs. |
| `~/.bun/bin` | Bun's own binaries (`bun`, `bunx`). |
| `~/.opencode/bin` | OpenCode's binary. |
| `~/.npm-global/bin` | npm's user-prefix global bins. |

**Package roots** allow only a strict subdir; the root itself is file-only
because it may hold config (for example `~/.npm-global/.npmrc`):

| Package root | Why |
|---|---|
| `~/.local/share/claude` | Claude Code's versioned native install; `~/.local/bin/claude` symlinks here. |
| `~/.bun` | Bun's install cache; `bunx` entries live under `install/cache`. |
| `~/.npm-global` | npm's user prefix; global packages live under `lib/node_modules`. |
| `~/.volta` | Volta's shims and installed toolchain. |
| `~/.nvm` | nvm's installed Node versions and global bins. |
| `~/.opencode` | OpenCode's install root; the binary is in `bin`. |

The lists are data next to the profile table; a new install root is a table edit.
A bound bin dir is read-only, but every file in it is readable by the harness;
keep secrets out of bin dirs and put credentials in a declared state dir.

## Presence probe

A harness is `ready` only when both hold:

1. **Resolvable without network.** A direct command is found on `PATH`. A `bunx`
   entry point is present in the local Bun install cache at the pinned version;
   otherwise the status is `missing` with reason `version_not_cached`. The probe
   never invokes a package manager in a way that can download.
2. **Handshake inside the sandbox.** Spawn the sandboxed harness, perform ACP
   `initialize` and `session/new`, then close. No prompt, no tool call, no
   permission request. `session/new` is part of the handshake because
   `auth_required` only surfaces there: an `initialize`-only probe cannot tell a
   logged-in harness from a logged-out one. The probe creates one empty session
   per harness per TTL; that is the cost of an honest `unauthenticated` status.

Classification:

| Observation | Status | Reason |
|---|---|---|
| Entry point not resolvable | `missing` | `not_installed` / `version_not_cached` |
| Spawn fails | `missing` | `spawn_failed` |
| ACP error `auth_required` | `unauthenticated` | `auth_required` |
| Handshake completes | `ready` | — |
| Timeout, crash, protocol error | `unknown` | the runtime error code |

Probe timeout 20 s, one probe at a time, cache TTL 300 s for a non-ready result
and 1 h for a `ready` one. A failed run invalidates that harness's cache entry
so the next heartbeat re-probes. Probe output is reduced to status and reason;
stderr is discarded, never logged or sent.

## Heartbeat additions

```ts
type HarnessReport = {
  id: string
  status: "ready" | "missing" | "unauthenticated" | "unknown"
  reason?: string
}

type HeartbeatRequest = {
  // ...existing fields unchanged
  harnesses: string[]            // ready ids only, as today
  harnessReport?: HarnessReport[]
  isolation?: { mode: "bwrap" | "sandbox-exec" | "none"; profile: string; selfTest: "pass" | "fail" }
}
```

Both fields are optional, so a version-1 hub ignores them and placement keeps
working. No protocol version bump.

## Numbers

| Setting | Default | Why |
|---|---|---|
| Probe timeout | 20 s | A cold `bunx` start is slow; a hung harness must not stall a beat |
| Probe cache TTL | 300 s non-ready, 1 h ready | A login is picked up within one beat cycle after the non-ready TTL; a ready harness is stable, so it is probed less often |
| Probe concurrency | 1 | designed for a 1 CPU node; parallel cold starts would starve the run |
| Sandbox self-test timeout | 10 s | A working bwrap returns in milliseconds |
| Profile version | `2` | Bumped when the mount table or argv shape changes; `2` adds the `claude` config-directory entry |

## Open questions, resolved with defaults

- **Does the node sandbox the probe?** Yes. A harness that only works unsandboxed
  is not ready, and reporting it ready would move the failure to run time.
- **Does the node sandbox `run.inspect` and `run.cancel`?** They act on an
  existing child; no new process is spawned, so no new sandbox is created.
- **What about harnesses that need a writable workspace to start?** The
  `read-only` profile is opt-in per run; the default stays `write`.
- **What if the workspace is a symlink?** Resolve it before binding; bind the
  target, and reject a workspace whose resolved path is `/` or the home root.
- **Does the hub need to know the profile?** Only for display. Placement uses the
  ready list, which already reflects it.

## Not researched further

Network egress allowlists, CPU and memory limits, seccomp filters beyond
`--cap-drop ALL`, and sandboxing gateway-backed tools are deferred. Each needs a
second real user before it earns code (constitution VII).
