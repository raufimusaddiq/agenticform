# Contract: Isolation

The sandbox shape the node builds for every harness child. This contract is
normative for `packages/node`; `runtime` is not aware of it.

## 1. Guarantee

For every harness in the catalog, under the `write` profile:

- a write inside the run's workspace succeeds;
- a write outside the workspace fails with `EROFS`;
- `$HOME` contains only the harness's declared state directories;
- `/tmp` is private to the run;
- `~/.ssh`, other projects and the node's state directory are not readable.

Under the `read-only` profile the workspace is read-only as well.

The node does not claim isolation for tools a gateway-backed harness runs outside
the local child process. That limit is stated in `docs/harnesses.md`.

## 2. Argv

```text
bwrap
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
  --die-with-parent --new-session --cap-drop ALL
  --clearenv
  --setenv PATH <allowlist PATH>
  --setenv HOME /home/agent
  [--setenv NAME VALUE ...]                      # profile allowlist, sorted
  --ro-bind /usr /usr                            # each path that exists
  --ro-bind /bin /bin
  --ro-bind /sbin /sbin
  --ro-bind /lib /lib
  --ro-bind /lib64 /lib64
  --ro-bind /opt /opt
  --ro-bind /etc /etc
  --ro-bind /run /run
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --tmpfs /home/agent
  (--bind | --ro-bind) <workspace> <workspace>
  (--bind | --ro-bind) <state-path> <state-path> ...
  --
  <harness.command> <harness.args...>
```

Rules:

- Order is fixed: unshare flags, lifecycle flags, environment, system binds,
  pseudo-filesystems, private tmpfs, workspace, state paths, `--`, command.
- `--unshare-net` MUST NOT appear.
- `--unshare-cgroup-try` MUST be used, so a kernel without cgroup namespaces does
  not fail the sandbox.
- The workspace and state paths MUST be absolute and resolved before binding.
- A read-only state path that does not exist is skipped; a read-write one is
  created with mode `0700`.
- The argv is built from the profile table only. No run input may add a bind.

## 3. Environment

The harness environment is exactly:

| Variable | Value |
|---|---|
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/home/agent` |
| `TERM`, `LANG`, `LC_ALL`, `TZ` | copied from the node only when set |
| profile `env` | the profile's declared entries |

`AGENTICFORM_*` variables, harness tokens read from the node's environment and any
other inherited variable MUST NOT appear. A profile that needs a variable adds it
to the table with its reason.

## 4. Profiles

```ts
type IsolationProfile = {
  version: 1
  workspace: "write" | "read-only"
  state: { path: string; mode: "rw" | "ro" }[]
  env?: Record<string, string>
}
```

| Harness | `rw` state | `ro` state |
|---|---|---|
| `claude` | `~/.claude` | `~/.config/claude` |
| `codex` | `~/.codex` | — |
| `opencode` | `~/.local/share/opencode` | `~/.config/opencode` |
| `omp` | `~/.omp` | — |
| `pi` | `~/.pi` | — |
| `dsh` | `~/.dsh` | — |
| `hermes` | `~/.hermes` | — |
| `openclaw` | `~/.openclaw` | — |
| custom or unknown | none | none |

The table is the intended contract, not yet verified per harness. Each entry must
be confirmed against the harness's own documentation and a real run (T023) before
it is final. A harness that needs another path is a table change with a
conformance run, not a runtime widening.

## 5. Self-test

At startup the node runs the exact argv for an empty profile with `true` as the
command and a temporary workspace, with a 10 s timeout. It MUST also verify the
denial boundary: a child that attempts to write outside the workspace exits
non-zero, and a child that writes inside the workspace exits zero.

Pass → `isolation.mode: "bwrap"` (or `"sandbox-exec"`), `selfTest: "pass"`.
Fail → `isolation.mode: "none"`, `selfTest: "fail"`, no harness advertised, every
run fails with `isolation_unavailable`. The result is not retried until restart.

## 6. Failure codes

| Code | Cause | Retry |
|---|---|---|
| `isolation_unavailable` | no primitive, self-test failure, sandbox spawn failure | Never within the run |
| `workspace_missing` | workspace path absent or resolves to `/` or the home root | Never |
| `harness_missing` | see [harness-detection.md](harness-detection.md) | No child started |
| `harness_unauthenticated` | see [harness-detection.md](harness-detection.md) | No child started |
| `harness_unavailable` | probe `unknown` | No child started |

A sandbox failure never falls back to an unsandboxed spawn, and a failed run never
causes the profile to widen.

## 7. Logging

The node logs the profile name and version, never the argv paths, on failure. The
harness's stderr stays out of events, the heartbeat and hub storage.