import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { HarnessDefinition } from "@agenticform/runtime"

/**
 * The sandbox shape for one harness (contracts/isolation.md §4). The table is
 * data: a harness that needs another path is a table edit, never a runtime
 * widening (FR-012).
 */
export type WorkspaceMode = "write" | "read-only"
export type StateMode = "rw" | "ro"

export interface IsolationProfile {
  version: 1
  workspace: WorkspaceMode
  state: { path: string; mode: StateMode }[]
  env?: Record<string, string>
}

export const PROFILE_VERSION = 1
export const SANDBOX_HOME = "/home/agent"
export const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin"

const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc", "/run"]
const COPIED_ENV = ["TERM", "LANG", "LC_ALL", "TZ"]

/** Verified mount table (T023); evidence in specs/003-harness-isolation/research.md. */
const TABLE: Readonly<Record<string, { rw: readonly string[]; ro: readonly string[] }>> = {
  claude: { rw: ["~/.claude"], ro: [] },
  codex: { rw: ["~/.codex"], ro: [] },
  opencode: { rw: ["~/.local/share/opencode"], ro: ["~/.config/opencode"] },
  omp: { rw: ["~/.omp"], ro: [] },
  pi: { rw: ["~/.pi"], ro: [] },
  dsh: { rw: ["~/.dsh"], ro: [] },
  hermes: { rw: ["~/.hermes"], ro: [] },
  openclaw: { rw: ["~/.openclaw"], ro: [] },
}

export class IsolationError extends Error {
  constructor(
    readonly code: "workspace_missing" | "isolation_unavailable" | "entry_dir_unsafe",
    message: string,
  ) {
    super(message)
    this.name = "IsolationError"
  }
}

/** The profile for a harness id; an unknown harness gets an empty profile (FR-010). */
export function profileFor(harness: string, workspace: WorkspaceMode = "write"): IsolationProfile {
  const entry = TABLE[harness]
  return {
    version: PROFILE_VERSION,
    workspace,
    state: entry
      ? [
          ...entry.rw.map((path) => ({ path, mode: "rw" as const })),
          ...entry.ro.map((path) => ({ path, mode: "ro" as const })),
        ]
      : [],
  }
}

/**
 * Resolve the workspace before binding, so a symlink cannot redirect a write
 * outside it (FR-008). `/` and the home root are refused: binding either would
 * make the whole machine writable.
 */
export function resolveWorkspace(cwd: string, home: string = homedir()): string {
  let resolved: string
  try {
    resolved = realpathSync(cwd)
  } catch {
    throw new IsolationError("workspace_missing", `workspace is missing: ${cwd}`)
  }
  let homeRoot: string
  try {
    homeRoot = realpathSync(home)
  } catch {
    homeRoot = resolve(home)
  }
  if (resolved === "/" || resolved === homeRoot) {
    throw new IsolationError("workspace_missing", `workspace must not be / or the home root: ${cwd}`)
  }
  return resolved
}

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)

const realpathOr = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** A temp root may be an entry dir: the probe workspace lives there. */
const TEMP_ROOTS = ["/tmp", "/var/tmp"]

/** `--dir` for each ancestor the sandbox root does not already provide. */
function dirArgs(dest: string, root: string): string[] {
  const rel = relative(root, dest)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return []
  const args: string[] = []
  let current = root
  for (const part of rel.split("/").slice(0, -1)) {
    if (!part) continue
    current = current === "/" ? `/${part}` : join(current, part)
    if (SYSTEM_PATHS.some((system) => isUnder(current, system))) continue
    args.push("--dir", current)
  }
  return args
}

/**
 * The argv after `bwrap`, in the fixed order of contracts/isolation.md §2.
 * State directories are bound under the sandbox home at the same relative path,
 * because the harness reads them through `$HOME` (which is `/home/agent`).
 */
export function sandboxArgs(
  profile: IsolationProfile,
  workspace: string,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
  options: {
    remountRoot?: boolean | undefined
    entryDirs?: readonly string[] | undefined
    entryFiles?: readonly string[] | undefined
  } = {},
): string[] {
  const homeRoot = realpathOr(home)
  const workspaceRoot = realpathOr(workspace)
  const tempRoots = TEMP_ROOTS.map(realpathOr)
  const stateBinds = profile.state.map((entry) => {
    const fromHome = entry.path.startsWith("~/")
    return {
      fromHome,
      source: fromHome ? join(home, entry.path.slice(1)) : entry.path,
      dest: fromHome ? join(SANDBOX_HOME, entry.path.slice(1)) : entry.path,
      mode: entry.mode,
    }
  })
  const stateSources = stateBinds.map((bind) => bind.source)
  // The entry point is resolved before the sandbox is built (T031). Refuse a
  // directory that would expose the whole machine or the home (the same guard
  // as resolveWorkspace), and skip one already covered by the workspace or a
  // state bind.
  const entryDirs = [...new Set(options.entryDirs ?? [])].filter((dir) => {
    if (!isAbsolute(dir) || !existsSync(dir)) return false
    const resolved = realpathOr(dir)
    if (resolved === "/" || resolved === homeRoot) {
      throw new IsolationError("entry_dir_unsafe", `entry directory is unsafe: ${dir}`)
    }
    if (isUnder(homeRoot, resolved)) {
      throw new IsolationError("entry_dir_unsafe", `entry directory is an ancestor of the home: ${dir}`)
    }
    if (isUnder(resolved, workspaceRoot) || stateSources.some((source) => isUnder(resolved, source))) {
      return false
    }
    return true
  })
  // A temp root or an ancestor of the workspace must not be bound whole: that
  // would expose every sibling (and break the private /tmp). Bind only the
  // resolved entry file(s) for those dirs.
  const unsafeDirs = entryDirs
    .map(realpathOr)
    .filter((dir) => tempRoots.includes(dir) || isUnder(workspaceRoot, dir))
  const entryFiles = [...new Set(options.entryFiles ?? [])].filter((file) => {
    if (!isAbsolute(file) || !existsSync(file)) return false
    const resolved = realpathOr(file)
    return unsafeDirs.some((dir) => isUnder(resolved, dir))
  })
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "PATH",
    [...entryDirs, SANDBOX_PATH].join(":"),
    "--setenv",
    "HOME",
    SANDBOX_HOME,
  ]
  for (const name of COPIED_ENV) {
    const value = env[name]
    if (value !== undefined) args.push("--setenv", name, value)
  }
  for (const [name, value] of Object.entries(profile.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--setenv", name, value)
  }
  for (const path of SYSTEM_PATHS) if (existsSync(path)) args.push("--ro-bind", path, path)
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", SANDBOX_HOME)
  args.push(profile.workspace === "read-only" ? "--ro-bind" : "--bind", workspace, workspace)
  for (const bind of stateBinds) {
    if (bind.mode === "ro") {
      if (!existsSync(bind.source)) continue
      args.push(...dirArgs(bind.dest, bind.fromHome ? SANDBOX_HOME : "/"), "--ro-bind", bind.source, bind.dest)
    } else {
      mkdirSync(bind.source, { recursive: true, mode: 0o700 })
      args.push(...dirArgs(bind.dest, bind.fromHome ? SANDBOX_HOME : "/"), "--bind", bind.source, bind.dest)
    }
  }
  // Entry-point binds come after the private tmpfs mounts and the workspace and
  // state binds, so a resolved entry anywhere (including under /tmp, which the
  // private tmpfs would otherwise shadow) is visible. A safe entry directory is
  // bound whole, read-only. A temp root or an ancestor of the workspace is not:
  // only the resolved entry file(s) are bound, so siblings stay invisible and
  // the private /tmp is preserved.
  for (const dir of entryDirs) {
    if (unsafeDirs.includes(realpathOr(dir))) continue
    args.push("--ro-bind", dir, dir)
  }
  for (const file of entryFiles) args.push("--ro-bind", file, file)
  // An entry dir can be an ancestor of the workspace or a state dir (for
  // example a binary in /var/tmp with a probe workspace under /var/tmp).
  // Re-bind both after the entry binds so the read-only entry mount cannot
  // shadow them.
  args.push(profile.workspace === "read-only" ? "--ro-bind" : "--bind", workspace, workspace)
  for (const bind of stateBinds) {
    if (bind.mode === "ro" && !existsSync(bind.source)) continue
    args.push(bind.mode === "ro" ? "--ro-bind" : "--bind", bind.source, bind.dest)
  }
  // The root tmpfs is writable by default, so a path next to the workspace
  // (created for the bind) would accept a write. Remounting it read-only makes
  // every unbound path fail with EROFS; the workspace, /tmp, the home and the
  // state binds are separate mounts and keep their own flags.
  if (options.remountRoot !== false) args.push("--remount-ro", "/")
  return args
}

/** Wrap a harness definition so `runtime` spawns `bwrap -- ...` (FR-001, FR-004). */
export function sandboxHarness(
  definition: HarnessDefinition,
  profile: IsolationProfile,
  workspace: string,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
  options: { entryDirs?: readonly string[] | undefined; entryFiles?: readonly string[] | undefined } = {},
): HarnessDefinition {
  return {
    ...definition,
    command: "bwrap",
    args: [...sandboxArgs(profile, workspace, home, env, options), "--", definition.command, ...(definition.args ?? [])],
  }
}

export interface SelfTestResult {
  mode: "bwrap" | "none"
  selfTest: "pass" | "fail"
  reason?: string
}

/**
 * Prove the exact shape a run uses, not that a binary exists (FR-013). A child
 * that writes inside the workspace must exit zero; one that writes to the
 * remounted root must not. The result is cached by the caller and never retried
 * until restart.
 */
export function selfTest(
  options: { timeoutMs?: number; env?: Record<string, string | undefined>; remountRoot?: boolean } = {},
): SelfTestResult {
  const timeoutMs = options.timeoutMs ?? 10_000
  const workspace = selfTestWorkspace()
  const profile: IsolationProfile = { version: PROFILE_VERSION, workspace: "write", state: [] }
  // The empty profile has no state paths, so the home is never bound; a fixed
  // value keeps the self-test independent of the host's /home layout.
  const args = sandboxArgs(profile, workspace, "/nonexistent", options.env ?? process.env, {
    remountRoot: options.remountRoot,
  })
  const run = (command: string[]) =>
    spawnSync("bwrap", [...args, "--", ...command], { timeout: timeoutMs, stdio: "ignore" })
  try {
    const basic = run(["true"])
    if (basic.error || basic.status !== 0) return { mode: "none", selfTest: "fail", reason: "sandbox_unavailable" }
    const inside = run(["touch", join(workspace, "ok")])
    if (inside.status !== 0) return { mode: "none", selfTest: "fail", reason: "workspace_write_denied" }
    // The root is not a separate read-only bind, so this only fails when
    // --remount-ro is present. A sibling of the workspace mount point is the
    // same check for the parent directory the bind creates.
    const outsideRoot = run(["touch", "/af-selftest-denied"])
    if (outsideRoot.status === 0) return { mode: "none", selfTest: "fail", reason: "write_not_denied" }
    if (!isUnder(workspace, tmpdir())) {
      const outsideSibling = run(["touch", join(dirname(workspace), "af-selftest-denied")])
      if (outsideSibling.status === 0) return { mode: "none", selfTest: "fail", reason: "write_not_denied" }
    }
    return { mode: "bwrap", selfTest: "pass" }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** /var/tmp is on the remounted root; /tmp is a private tmpfs and cannot prove it. */
function selfTestWorkspace(): string {
  try {
    return mkdtempSync(join("/var/tmp", "af-selftest-"))
  } catch {
    return mkdtempSync(join(tmpdir(), "af-selftest-"))
  }
}
