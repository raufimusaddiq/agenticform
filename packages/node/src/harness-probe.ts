import { accessSync, closeSync, constants, existsSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import type { HarnessReport, HarnessReportReason, HarnessStatus } from "@agenticform/protocol"
import { HARNESS_REPORT_REASON_SET } from "@agenticform/protocol"
import { AcpDriver, RuntimeError, type HarnessDefinition, type RuntimeDriver } from "@agenticform/runtime"
import { IsolationError, profileFor, sandboxHarness } from "./isolation.ts"

/**
 * Entry-point resolution (contracts/harness-detection.md §2.1). It never runs a
 * package manager and never touches the network: a direct command is found on
 * PATH, a `bunx` entry must already be in the local Bun cache. The resolved
 * directory is what the sandbox binds, so a harness installed under the home is
 * reachable without widening the state table (FR-018, FR-019).
 */
export interface ResolvedHarness {
  definition: HarnessDefinition
  /** Absolute directories to bind read-only and put on the sandbox PATH. */
  dirs: string[]
  /** The entry file and its interpreter, for a dir that must not be bound whole. */
  files: string[]
}

export type HarnessResolution =
  | { ok: true; resolved: ResolvedHarness }
  | { ok: false; status: "missing"; reason: "not_installed" | "version_not_cached" }

export interface ResolveOptions {
  path?: string
  home?: string
  cacheRoot?: string
}

const missing = (reason: "not_installed" | "version_not_cached"): HarnessResolution => ({
  ok: false,
  status: "missing",
  reason,
})

const unique = (paths: string[]): string[] => [...new Set(paths)]

function findOnPath(command: string, path: string): string | null {
  if (isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK)
      return statSync(command).isFile() ? command : null
    } catch {
      return null
    }
  }
  for (const dir of path.split(":")) {
    if (!dir) continue
    const candidate = join(dir, command)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return null
}

/** The first line of a script, read without loading a whole binary. */
function shebang(file: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const buffer = Buffer.alloc(256)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const first = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? ""
    return first.startsWith("#!") ? first.slice(2).trim() : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** `#!/usr/bin/env bun` names `bun`; `#!/bin/sh` names `/bin/sh`. */
function interpreterOf(file: string): string | null {
  const line = shebang(file)
  if (!line) return null
  const parts = line.split(/\s+/)
  if (parts[0]?.endsWith("/env")) return parts[1] ?? null
  return parts[0] ?? null
}

function resolveDirect(definition: HarnessDefinition, options: ResolveOptions): HarnessResolution {
  const path = options.path ?? process.env.PATH ?? ""
  const found = findOnPath(definition.command, path)
  if (!found) return missing("not_installed")
  let real = found
  try {
    real = realpathSync(found)
  } catch {
    // A broken symlink is not runnable.
    return missing("not_installed")
  }
  const dirs = [dirname(real)]
  const files = [real]
  const interpreter = interpreterOf(real)
  if (interpreter) {
    const resolved = findOnPath(interpreter, path)
    if (resolved) {
      try {
        const realInterpreter = realpathSync(resolved)
        dirs.push(dirname(realInterpreter))
        files.push(realInterpreter)
      } catch {
        dirs.push(dirname(resolved))
        files.push(resolved)
      }
    }
  }
  return {
    ok: true,
    resolved: {
      definition: { ...definition, command: real, args: [...(definition.args ?? [])] },
      dirs: unique(dirs),
      files: unique(files),
    },
  }
}

/** `@scope/name@1.2.3` or `name@1.2.3`; the last `@` separates the version. */
function splitSpec(spec: string): { name: string; version: string } | null {
  const at = spec.lastIndexOf("@")
  if (at <= 0 || at === spec.length - 1) return null
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

function bunxRoot(cacheRoot: string, name: string, version: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(cacheRoot)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.startsWith(".bunx-")) continue
    const candidate = join(cacheRoot, entry, `${name}@${version}`)
    if (existsSync(join(candidate, "node_modules", name, "package.json"))) return candidate
  }
  return null
}

function resolveBunx(definition: HarnessDefinition, options: ResolveOptions): HarnessResolution {
  const spec = definition.args?.[0]
  if (!spec) return missing("not_installed")
  const parsed = splitSpec(spec)
  if (!parsed) return missing("not_installed")
  const cacheRoot = options.cacheRoot ?? join(options.home ?? homedir(), ".bun", "install", "cache")
  const root = bunxRoot(cacheRoot, parsed.name, parsed.version)
  if (!root) return missing("version_not_cached")
  const packageDir = join(root, "node_modules", parsed.name)
  let manifest: { bin?: string | Record<string, string> }
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as typeof manifest
  } catch {
    return missing("not_installed")
  }
  const bin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : (manifest.bin?.[basename(parsed.name)] ?? Object.values(manifest.bin ?? {})[0])
  if (!bin) return missing("not_installed")
  const path = options.path ?? process.env.PATH ?? ""
  const bun = findOnPath("bun", path) ?? findOnPath("bunx", path)
  if (!bun) return missing("not_installed")
  let bunReal = bun
  try {
    bunReal = realpathSync(bun)
  } catch {
    // Keep the path we found.
  }
  const script = join(packageDir, bin)
  return {
    ok: true,
    resolved: {
      definition: {
        ...definition,
        command: bunReal,
        args: [script, ...(definition.args ?? []).slice(1)],
      },
      dirs: unique([dirname(bunReal), join(root, "node_modules")]),
      files: unique([bunReal, script]),
    },
  }
}

export function resolveHarness(definition: HarnessDefinition, options: ResolveOptions = {}): HarnessResolution {
  return definition.command === "bunx" ? resolveBunx(definition, options) : resolveDirect(definition, options)
}

export interface ProbeOptions {
  timeoutMs: number
  home?: string
  env?: Record<string, string | undefined>
  driver?: RuntimeDriver
  workspaceRoot?: string
  resolve?: (definition: HarnessDefinition) => HarnessResolution
}

const probeRoot = (): string => {
  try {
    accessSync("/var/tmp", constants.W_OK)
    return "/var/tmp"
  } catch {
    return tmpdir()
  }
}

function reasonOf(error: unknown): HarnessReportReason {
  const code = error instanceof IsolationError ? error.code : error instanceof RuntimeError ? error.code : "agent_error"
  return HARNESS_REPORT_REASON_SET.has(code) ? (code as HarnessReportReason) : "agent_error"
}

function classify(error: unknown): { status: HarnessStatus; reason: HarnessReportReason } {
  const reason = reasonOf(error)
  if (reason === "auth_required") return { status: "unauthenticated", reason }
  if (reason === "spawn_failed") return { status: "missing", reason }
  return { status: "unknown", reason }
}

async function bounded<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new RuntimeError("handshake_timeout", "probe timed out"))
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve, then run the ACP handshake inside the sandbox (contracts/
 * harness-detection.md §2.2). `initialize` and `session/new` are the handshake:
 * `session/new` is where a harness reports `auth_required`. No prompt, no tool
 * call, no permission request. Output is reduced to a status and a reason.
 */
export async function probeHarness(definition: HarnessDefinition, options: ProbeOptions): Promise<HarnessReport> {
  const resolution = (options.resolve ?? resolveHarness)(definition)
  if (!resolution.ok) return { id: definition.id, status: "missing", reason: resolution.reason }
  const workspace = mkdtempSync(join(options.workspaceRoot ?? probeRoot(), "af-probe-"))
  const controller = new AbortController()
  const driver = options.driver ?? new AcpDriver()
  try {
    // The argv builder can refuse an unsafe entry dir; that is an `unknown`
    // probe, not a spawn failure.
    const sandboxed = sandboxHarness(
      resolution.resolved.definition,
      profileFor(definition.id),
      workspace,
      options.home ?? homedir(),
      options.env ?? process.env,
      { entryDirs: resolution.resolved.dirs, entryFiles: resolution.resolved.files },
    )
    const connection = await bounded(
      driver.connect(
        { harness: sandboxed, cwd: workspace, env: {} },
        { emit: () => {}, decide: async () => "deny" as const },
        controller.signal,
      ),
      options.timeoutMs,
      () => controller.abort(new RuntimeError("handshake_timeout", "probe timed out")),
    )
    try {
      await bounded(
        connection.openSession({ cwd: workspace, mcpServers: [] }),
        options.timeoutMs,
        () => controller.abort(new RuntimeError("handshake_timeout", "probe timed out")),
      )
    } finally {
      await connection.close()
    }
    return { id: definition.id, status: "ready" }
  } catch (error) {
    return { id: definition.id, ...classify(error) }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

export interface HarnessProberOptions {
  definitions: () => HarnessDefinition[]
  /** TTL for a non-ready result. */
  ttlMs: number
  /** TTL for a ready result; a ready harness is stable, so it is cached longer. */
  readyTtlMs: number
  timeoutMs: number
  home?: string
  env?: Record<string, string | undefined>
  driver?: RuntimeDriver
  now?: () => number
  probe?: (definition: HarnessDefinition) => Promise<HarnessReport>
}

/**
 * TTL cache, one probe at a time, single-flight (contracts/harness-detection.md
 * §3). `report` is synchronous so a heartbeat never waits on a probe; a result
 * lands on a later beat. A failed run invalidates its entry.
 */
export class HarnessProber {
  private readonly cache = new Map<string, { report: HarnessReport; at: number }>()
  private readonly entries = new Map<string, ResolvedHarness>()
  private readonly pending = new Map<string, Promise<HarnessReport>>()
  private inflight: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly options: HarnessProberOptions) {
    this.now = options.now ?? Date.now
  }

  report(): HarnessReport[] {
    return this.options.definitions().map(
      (definition) => this.cache.get(definition.id)?.report ?? { id: definition.id, status: "unknown" },
    )
  }

  status(id: string): HarnessStatus | undefined {
    return this.cache.get(id)?.report.status
  }

  /** The entry point the last probe resolved, so a run does not re-resolve it. */
  resolved(id: string): ResolvedHarness | undefined {
    return this.entries.get(id)
  }

  /**
   * Await a fresh status for one harness. It probes only that id (per-id
   * single-flight), so a hung sibling cannot delay a run for a healthy one.
   */
  async ensure(id: string): Promise<HarnessStatus | undefined> {
    if (this.fresh(id)) return this.status(id)
    const definition = this.options.definitions().find((item) => item.id === id)
    if (!definition) return undefined
    const report = await this.probeOne(definition)
    this.cache.set(id, { report, at: this.now() })
    return report.status
  }

  invalidate(id: string): void {
    this.cache.delete(id)
    this.entries.delete(id)
  }

  refresh(): Promise<void> {
    this.inflight ??= this.run().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private fresh(id: string): boolean {
    const entry = this.cache.get(id)
    if (entry === undefined) return false
    const ttl = entry.report.status === "ready" ? this.options.readyTtlMs : this.options.ttlMs
    return this.now() - entry.at < ttl
  }

  /** One probe per id at a time; a second caller joins the in-flight probe. */
  private probeOne(definition: HarnessDefinition): Promise<HarnessReport> {
    const existing = this.pending.get(definition.id)
    if (existing) return existing
    const work = this.probe(definition).finally(() => {
      this.pending.delete(definition.id)
    })
    this.pending.set(definition.id, work)
    return work
  }

  private async probe(definition: HarnessDefinition): Promise<HarnessReport> {
    // Resolve once per probe and keep it: the executor reuses the dirs.
    const resolution = resolveHarness(definition, {
      ...(this.options.home === undefined ? {} : { home: this.options.home }),
      ...(this.options.env?.PATH === undefined ? {} : { path: this.options.env.PATH }),
    })
    if (resolution.ok) this.entries.set(definition.id, resolution.resolved)
    else this.entries.delete(definition.id)
    try {
      return await (this.options.probe?.(definition) ??
        probeHarness(definition, {
          timeoutMs: this.options.timeoutMs,
          resolve: () => resolution,
          ...(this.options.home === undefined ? {} : { home: this.options.home }),
          ...(this.options.env === undefined ? {} : { env: this.options.env }),
          ...(this.options.driver === undefined ? {} : { driver: this.options.driver }),
        }))
    } catch (error) {
      // A probe never rejects the refresh: an unexpected failure is `unknown`.
      return { id: definition.id, status: "unknown", reason: reasonOf(error) }
    }
  }

  private async run(): Promise<void> {
    for (const definition of this.options.definitions()) {
      if (this.fresh(definition.id)) continue
      const report = await this.probeOne(definition)
      this.cache.set(definition.id, { report, at: this.now() })
    }
  }
}
