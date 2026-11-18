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
    readonly code: "workspace_missing" | "isolation_unavailable",
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

/**
 * Install roots under HOME (contracts/isolation.md §2). Two kinds of data:
 * - bin dirs are bound as-is (the dir itself, read-only, on PATH);
 * - package roots allow only a strict subdir; the root itself is file-only.
 * Evidence is in research.md.
 */
const HOME_BIN_DIRS = ["~/.local/bin", "~/.bun/bin", "~/.opencode/bin", "~/.npm-global/bin"] as const
const HOME_PACKAGE_ROOTS = [
  "~/.local/share/claude",
  "~/.bun",
  "~/.npm-global",
  "~/.volta",
  "~/.nvm",
  "~/.opencode",
] as const

export interface EntryPoint {
  command: string
  dirs: readonly string[]
  files: readonly string[]
}

export interface EntryBinds {
  /** The command to spawn inside the sandbox. */
  command: string
  /** Host directories to bind read-only at the same path. */
  dirBinds: string[]
  /** Host files to bind read-only at the same path. */
  fileBinds: string[]
  /** In-sandbox directories that exist and may go on PATH. */
  pathDirs: string[]
}

/**
 * One rule for entry binds (contracts/isolation.md §2):
 * - a real file inside a declared state dir is reached through that state bind,
 *   so the command and PATH entry are mapped to the in-sandbox path;
 * - otherwise, under HOME, a directory is bound only when it is inside the
 *   install-root allowlist; anything else under HOME binds only the entry and
 *   interpreter files;
 * - outside HOME, bind the smallest dir containing the real file, never `/`, a
 *   temp root or a workspace ancestor; those are file-only too.
 */
export function entryBinds(
  entry: EntryPoint,
  profile: IsolationProfile,
  workspace: string,
  home: string,
): EntryBinds {
  const homeRoot = realpathOr(home)
  const workspaceRoot = realpathOr(workspace)
  const tempRoots = TEMP_ROOTS.map(realpathOr)
  const stateBinds = profile.state.map((item) => {
    const fromHome = item.path.startsWith("~/")
    return {
      source: fromHome ? join(home, item.path.slice(1)) : item.path,
      dest: fromHome ? join(SANDBOX_HOME, item.path.slice(1)) : item.path,
    }
  })
  const stateSources = stateBinds.map((bind) => bind.source)
  const binDirs = HOME_BIN_DIRS.map((path) => realpathOr(join(home, path.slice(2)))).filter((dir) => existsSync(dir))
  const packageRoots = HOME_PACKAGE_ROOTS.map((path) => realpathOr(join(home, path.slice(2))))

  const commandReal = entry.command ? realpathOr(entry.command) : ""
  // (1) The real file is inside a declared state dir: use the state bind.
  const state = commandReal ? stateBinds.find((bind) => isUnder(commandReal, bind.source)) : undefined
  const command = state ? join(state.dest, relative(state.source, commandReal)) : entry.command

  const dirBinds: string[] = []
  const fileBinds: string[] = []
  const pathDirs: string[] = []
  if (state) pathDirs.push(dirname(command))
  for (const dir of [...new Set(entry.dirs)]) {
    if (!isAbsolute(dir) || !existsSync(dir)) continue
    const resolved = realpathOr(dir)
    // Inside the workspace or a state dir: the existing bind already exposes it.
    if (isUnder(resolved, workspaceRoot)) continue
    const inside = stateBinds.find((bind) => isUnder(resolved, bind.source))
    if (inside) {
      pathDirs.push(join(inside.dest, relative(inside.source, resolved)))
      continue
    }
    const underHome = isUnder(resolved, homeRoot)
    // A bin dir is bound as-is; a package root only allows a strict subdir, so
    // a binary directly in the root (which may hold config such as
    // ~/.npm-global/.npmrc) is file-only.
    const allowedUnderHome =
      binDirs.includes(resolved) || packageRoots.some((root) => resolved !== root && isUnder(resolved, root))
    const unsafe =
      resolved === "/" ||
      resolved === homeRoot ||
      isUnder(homeRoot, resolved) ||
      stateSources.some((source) => isUnder(source, resolved)) ||
      tempRoots.includes(resolved) ||
      isUnder(workspaceRoot, resolved) ||
      (underHome && !allowedUnderHome)
    if (unsafe) {
      for (const file of entry.files) {
        if (!isAbsolute(file) || !existsSync(file)) continue
        if (isUnder(realpathOr(file), resolved)) fileBinds.push(file)
      }
      continue
    }
    dirBinds.push(dir)
    pathDirs.push(dir)
  }
  // The command itself must be reachable even if no dir was bound for it.
  if (commandReal && !state && !dirBinds.some((dir) => isUnder(commandReal, realpathOr(dir)))) {
    if (!fileBinds.some((file) => realpathOr(file) === commandReal)) fileBinds.push(entry.command)
  }
  return {
    command,
    dirBinds: [...new Set(dirBinds)],
    fileBinds: [...new Set(fileBinds)],
    pathDirs: [...new Set(pathDirs)],
  }
}

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
    entryCommand?: string | undefined
    entryBinds?: EntryBinds | undefined
  } = {},
): string[] {
  const binds =
    options.entryBinds ??
    entryBinds(
      { command: options.entryCommand ?? "", dirs: options.entryDirs ?? [], files: options.entryFiles ?? [] },
      profile,
      workspace,
      home,
    )
  const stateBinds = profile.state.map((entry) => {
    const fromHome = entry.path.startsWith("~/")
    return {
      fromHome,
      source: fromHome ? join(home, entry.path.slice(1)) : entry.path,
      dest: fromHome ? join(SANDBOX_HOME, entry.path.slice(1)) : entry.path,
      mode: entry.mode,
    }
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
    [...binds.pathDirs, SANDBOX_PATH].join(":"),
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
  // bound whole, read-only. An unsafe dir (temp root, home root, ancestor of
  // HOME/state/workspace, protected home dir) binds only the entry and
  // interpreter files, so siblings stay invisible and the private /tmp is
  // preserved.
  for (const dir of binds.dirBinds) args.push("--ro-bind", dir, dir)
  for (const file of binds.fileBinds) args.push("--ro-bind", file, file)
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
  const binds = entryBinds(
    { command: definition.command, dirs: options.entryDirs ?? [], files: options.entryFiles ?? [] },
    profile,
    workspace,
    home,
  )
  return {
    ...definition,
    command: "bwrap",
    args: [
      ...sandboxArgs(profile, workspace, home, env, { ...options, entryBinds: binds }),
      "--",
      binds.command,
      ...(definition.args ?? []),
    ],
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

let startupResult: SelfTestResult | undefined

/**
 * The startup result, computed once per process. The contract forbids retrying
 * until restart, so a later call returns the first answer (FR-013, FR-014).
 */
export function startupSelfTest(options: Parameters<typeof selfTest>[0] = {}): SelfTestResult {
  startupResult ??= selfTest(options)
  return startupResult
}

/** /var/tmp is on the remounted root; /tmp is a private tmpfs and cannot prove it. */
function selfTestWorkspace(): string {
  try {
    return mkdtempSync(join("/var/tmp", "af-selftest-"))
  } catch {
    return mkdtempSync(join(tmpdir(), "af-selftest-"))
  }
}
