# Research: Harness Isolation and Presence

Checked on 2026-11-18 on the target host (Linux 6.8.0, 1 CPU / 2 GB, no root).
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
| Harness presence | ACP handshake probe inside the sandbox | reading credential files: fragile, and it reads secrets |
| Probe cache | TTL 300 s, re-probe after a failed run | probing every heartbeat: 8 harnesses × 15 s is wasteful on 1 CPU |
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

**To be verified per harness, not final.** These paths are the intended shape,
not a checked fact: each entry must be confirmed against the harness's own
documentation and a real run before the table is treated as the contract. A wrong
entry is a table bug, fixed by editing the table and re-running the conformance
probe, never by widening the mount for everyone.

| Harness | Read-write | Read-only |
|---|---|---|
| `claude` | `~/.claude` | `~/.config/claude` |
| `codex` | `~/.codex` | — |
| `opencode` | `~/.local/share/opencode` | `~/.config/opencode` |
| `omp` | `~/.omp` | — |
| `pi` | `~/.pi` | — |
| `dsh` | `~/.dsh` | — |
| `hermes` | `~/.hermes` | — |
| `openclaw` | `~/.openclaw` | — |
| custom / unknown | none | none |

Paths are resolved against the node user's home before binding. A path that does
not exist is created `0700` for read-write entries and skipped for read-only
entries, so a missing optional config directory does not fail the run.

## Presence probe

A harness is `ready` only when both hold:

1. **Resolvable without network.** A direct command is found on `PATH`. A `bunx`
   entry point is present in the local Bun install cache at the pinned version;
   otherwise the status is `missing` with reason `version_not_cached`. The probe
   never invokes a package manager in a way that can download.
2. **Handshake inside the sandbox.** Spawn the sandboxed harness, perform ACP
   `initialize` only, then close. No session, no prompt, no tool call.

Classification:

| Observation | Status | Reason |
|---|---|---|
| Entry point not resolvable | `missing` | `not_installed` / `version_not_cached` |
| Spawn fails | `missing` | `spawn_failed` |
| ACP error `auth_required` | `unauthenticated` | `auth_required` |
| Handshake completes | `ready` | — |
| Timeout, crash, protocol error | `unknown` | the runtime error code |

Probe timeout 20 s, one probe at a time, cache TTL 300 s. A failed run invalidates
that harness's cache entry so the next heartbeat re-probes. Probe output is
reduced to status and reason; stderr is discarded, never logged or sent.

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
| Probe cache TTL | 300 s | A login is picked up within one beat cycle after the TTL |
| Probe concurrency | 1 | 1 CPU host; parallel cold starts would starve the run |
| Sandbox self-test timeout | 10 s | A working bwrap returns in milliseconds |
| Profile version | `1` | Bumped when the mount table or argv shape changes |

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
