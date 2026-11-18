import type { RunEventInput, RuntimeInventoryEntry } from "@agenticform/protocol"
import type { HarnessStatus } from "@agenticform/protocol"
import {
  createRuntime,
  type Capability,
  type McpServer,
  type Run,
  type RunResult,
  type Runtime,
} from "@agenticform/runtime"
import type { CommandEnvelope } from "@agenticform/protocol"
import { normaliseEvent } from "./events.ts"
import { resolveHarness, type ResolvedHarness } from "./harness-probe.ts"
import { IsolationError, profileFor, resolveWorkspace, sandboxHarness, type SelfTestResult } from "./isolation.ts"
import { CommandLedger } from "./ledger.ts"
import { NodeState, fingerprintError, payloadGenerationError } from "./state.ts"

export interface ExecutionContext {
  emit(event: RunEventInput): void
  signal: AbortSignal
}

export interface ExecutionOutcome {
  status: "succeeded" | "failed"
  result?: unknown
  error?: { code: string; message: string }
}

export interface ExecutorOptions {
  runtime?: Runtime
  /** Ledger directory; omitted keeps receipts in memory. */
  ledgerDir?: string
  /** Retention window for terminal receipts. */
  ledgerRetentionMs?: number
  /** Harness ids this node offers; an unconfigured id is `harness_missing`. */
  harnesses?: readonly string[]
  /** Probe status for a harness; omitted skips the pre-run gate (tests, custom callers). */
  harnessStatus?: (id: string) => HarnessStatus | undefined
  /** Trigger a single-flight probe and return the fresh status. */
  harnessProbe?: (id: string) => Promise<HarnessStatus | undefined>
  /** The entry point the prober already resolved, so a run does not re-resolve it. */
  harnessEntry?: (id: string) => ResolvedHarness | undefined
  /** Called after a failed run so the next heartbeat re-probes that harness. */
  harnessFailed?: (id: string) => void
  /** Bound on the pre-run probe wait. Default 30 s. */
  probeWaitMs?: number
  /** Home used to resolve the entry point; must match the prober's. */
  home?: string
  /** Environment used to resolve the entry point; must match the prober's. */
  env?: Record<string, string | undefined>
  /** Startup self-test result; `mode: "none"` refuses every run (FR-014). */
  isolation?: SelfTestResult
}

interface ActiveRun {
  run: Run
  harness: string
  state: string
}

function outcomeOf(result: RunResult): ExecutionOutcome {
  if (result.status === "completed") {
    return { status: "succeeded", result: { status: "completed", text: result.text } }
  }
  if (result.status === "cancelled") {
    return { status: "succeeded", result: { status: "cancelled", text: result.text } }
  }
  if (result.status === "incomplete") {
    return {
      status: "failed",
      error: { code: "incomplete", message: result.stopReason ?? "run did not complete" },
    }
  }
  return { status: "failed", error: result.error ?? { code: "agent_error", message: "run failed" } }
}

/** Resolve to `undefined` when `work` does not finish within `ms`. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A sandbox that cannot start fails the run; there is no unsandboxed retry
 * (FR-015). `spawn_failed` means bwrap itself is missing. A bwrap setup error
 * exits before the harness and prints `bwrap:` on stderr; an `execvp` failure
 * is the harness entry point, not the sandbox.
 */
function sandboxFailed(run: Run, outcome: ExecutionOutcome): boolean {
  if (outcome.status !== "failed") return false
  if (outcome.error?.code === "spawn_failed") return true
  if (outcome.error?.code !== "process_exited") return false
  const stderr = run.stderrTail().trimStart()
  return stderr.startsWith("bwrap:") && !stderr.includes("execvp")
}

/** Two resolved entries are the same when the command, dirs and files match. */
function sameEntry(a: ResolvedHarness, b: ResolvedHarness): boolean {
  return (
    a.definition.command === b.definition.command &&
    a.dirs.length === b.dirs.length &&
    a.dirs.every((dir, index) => dir === b.dirs[index]) &&
    a.files.length === b.files.length &&
    a.files.every((file, index) => file === b.files[index])
  )
}

/**
 * Executes hub commands through `runtime` (FR-019). The node owns no harness
 * logic: it maps a command to a runtime input and a runtime result to a
 * completion. Receipts are durable when a ledger directory is configured.
 */
export class Executor {
  private readonly runtime: Runtime
  private readonly ledger: CommandLedger
  private readonly active = new Map<string, ActiveRun>()
  private readonly state = new NodeState()
  private readonly configuredHarnesses: readonly string[] | undefined
  private readonly harnessStatus: ((id: string) => HarnessStatus | undefined) | undefined
  private readonly harnessProbe: ((id: string) => Promise<HarnessStatus | undefined>) | undefined
  private readonly harnessEntry: ((id: string) => ResolvedHarness | undefined) | undefined
  private readonly harnessFailed: ((id: string) => void) | undefined
  private readonly probeWaitMs: number
  private readonly home: string | undefined
  private readonly env: Record<string, string | undefined> | undefined
  private readonly isolation: SelfTestResult | undefined
  private staleCount = 0

  constructor(options: ExecutorOptions = {}) {
    this.runtime = options.runtime ?? createRuntime()
    this.ledger = new CommandLedger({
      ...(options.ledgerDir === undefined ? {} : { dir: options.ledgerDir }),
      ...(options.ledgerRetentionMs === undefined ? {} : { retentionMs: options.ledgerRetentionMs }),
    })
    this.configuredHarnesses = options.harnesses
    this.harnessStatus = options.harnessStatus
    this.harnessProbe = options.harnessProbe
    this.harnessEntry = options.harnessEntry
    this.harnessFailed = options.harnessFailed
    this.probeWaitMs = options.probeWaitMs ?? 30_000
    this.home = options.home
    this.env = options.env
    this.isolation = options.isolation
  }

  get activeCount(): number {
    return this.active.size
  }

  /** Commands refused because their generation was older than the active run. */
  get staleObservations(): number {
    return this.staleCount
  }

  /** The harness ids the runtime catalog knows. */
  harnesses(): string[] {
    return this.runtime.harnesses().map((harness) => harness.id)
  }

  inventory(): RuntimeInventoryEntry[] {
    return [...this.active.entries()].map(([runId, active]) => ({
      runId,
      generation: this.state.currentGeneration(runId) ?? 0,
      runtimeType: active.harness,
      runtimeSessionId: "",
      state: active.state,
    }))
  }

  async execute(command: CommandEnvelope, context: ExecutionContext): Promise<ExecutionOutcome> {
    // FR-021: a payload generation that disagrees with the envelope is refused
    // before any side effect, for every command type.
    const generationError = payloadGenerationError(command)
    if (generationError) {
      this.staleCount += 1
      return { status: "failed", error: { code: "fence_stale", message: generationError } }
    }
    const fingerprintProblem = fingerprintError(command)
    if (fingerprintProblem) {
      return { status: "failed", error: { code: "idempotency_conflict", message: fingerprintProblem } }
    }
    // FR-028, FR-031: the ledger admits a fresh id once, replays a cached
    // terminal result, and refuses a reuse or an interrupted receipt.
    const admission = this.ledger.admit(command)
    if (admission.kind === "invalid") {
      return { status: "failed", error: { code: "invalid_input", message: admission.message } }
    }
    if (admission.kind === "conflict") {
      return {
        status: "failed",
        error: { code: "idempotency_conflict", message: "command id reused with a different fingerprint" },
      }
    }
    if (admission.kind === "ambiguous") {
      return { status: "failed", error: { code: "ambiguous_replay", message: admission.message } }
    }
    if (admission.kind === "replay") return admission.outcome
    // `started` is persisted before the effect. A throw leaves it in place, so a
    // redelivery is refused as ambiguous instead of running twice (N6.1, N6.3).
    const outcome = await this.dispatch(command, context)
    this.ledger.settle(command, outcome)
    return outcome
  }

  private async dispatch(command: CommandEnvelope, context: ExecutionContext): Promise<ExecutionOutcome> {
    if (command.type === "run.cancel") return this.cancel(command)
    if (command.type === "run.inspect") return this.inspect(command)
    return this.start(command, context)
  }

  async cancel(command: CommandEnvelope): Promise<ExecutionOutcome> {
    const active = this.active.get(command.runId)
    if (active && this.isStale(command)) {
      this.staleCount += 1
      return {
        status: "failed",
        error: { code: "fence_stale", message: "command generation is older than the active run" },
      }
    }
    if (active) {
      active.state = "cancelling"
      await active.run.cancel()
    }
    return { status: "succeeded", result: { status: "cancelled" } }
  }

  inspect(command: CommandEnvelope): ExecutionOutcome {
    const active = this.active.get(command.runId)
    if (active && this.isStale(command)) {
      this.staleCount += 1
      return {
        status: "failed",
        error: { code: "fence_stale", message: "command generation is older than the active run" },
      }
    }
    if (!active) {
      return {
        status: "succeeded",
        result: { status: "absent", runId: command.runId, state: "absent", generation: null },
      }
    }
    return {
      status: "succeeded",
      result: {
        status: "inspected",
        runId: command.runId,
        state: active.state,
        generation: this.state.currentGeneration(command.runId),
      },
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((active) => active.run.cancel()))
  }

  private isStale(command: CommandEnvelope): boolean {
    const current = this.state.currentGeneration(command.runId)
    return current !== null && command.generation < current
  }

  private async start(command: CommandEnvelope, context: ExecutionContext): Promise<ExecutionOutcome> {
    const payload = command.payload
    if (typeof payload.harness !== "string" || !payload.harness) {
      return { status: "failed", error: { code: "invalid_input", message: "harness is required" } }
    }
    if (typeof payload.cwd !== "string" || !payload.cwd) {
      return { status: "failed", error: { code: "invalid_input", message: "cwd is required" } }
    }
    if (typeof payload.prompt !== "string" || !payload.prompt) {
      return { status: "failed", error: { code: "invalid_input", message: "prompt is required" } }
    }
    // FR-014: no usable sandbox means no run. The result is fixed at startup,
    // so this is a constant refusal, not a retry.
    if (this.isolation?.mode === "none") {
      return {
        status: "failed",
        error: {
          code: "isolation_unavailable",
          message: `Sandbox is unavailable: ${this.isolation.reason ?? "self-test failed"}`,
        },
      }
    }
    // spec.md: a missing working directory fails the run before the harness
    // starts, rather than letting the harness fail with an opaque error. The
    // resolved path is what gets bound, so a symlink cannot escape (FR-008).
    let workspace: string
    try {
      workspace = resolveWorkspace(payload.cwd, this.home)
    } catch (error) {
      if (error instanceof IsolationError) {
        return { status: "failed", error: { code: error.code, message: error.message } }
      }
      throw error
    }
    // contracts/harness-detection.md §5: a harness this node does not offer is
    // `harness_missing`, even if the runtime catalog knows it. An empty list
    // means "all configured", matching the node's advertisement filter.
    if (this.configuredHarnesses && this.configuredHarnesses.length > 0 && !this.configuredHarnesses.includes(payload.harness)) {
      return {
        status: "failed",
        error: { code: "harness_missing", message: `Harness is not configured on this node: ${payload.harness}` },
      }
    }
    const definition = this.runtime.harnesses().find((harness) => harness.id === payload.harness)
    if (!definition) {
      return {
        status: "failed",
        error: { code: "harness_missing", message: `Harness is not configured on this node: ${payload.harness}` },
      }
    }
    // FR-023, FR-024: a non-ready harness fails with its named code before any
    // child starts. The gate is skipped only when no prober is wired (tests).
    if (this.harnessStatus) {
      let status = this.harnessStatus(payload.harness)
      // A run can arrive before the first probe (for example right after a
      // restart). Trigger the single-flight probe and wait for it, bounded,
      // instead of failing with a misleading "unavailable".
      if (status === undefined && this.harnessProbe) {
        status = await withTimeout(this.harnessProbe(payload.harness), this.probeWaitMs)
      }
      if (status === "missing") {
        return { status: "failed", error: { code: "harness_missing", message: `Harness is missing: ${payload.harness}` } }
      }
      if (status === "unauthenticated") {
        return {
          status: "failed",
          error: { code: "harness_unauthenticated", message: `Harness needs authentication: ${payload.harness}` },
        }
      }
      if (status !== "ready") {
        return {
          status: "failed",
          error: {
            code: "harness_unavailable",
            message:
              status === undefined
                ? `Harness probe did not finish: ${payload.harness}`
                : `Harness is unavailable: ${payload.harness}`,
          },
        }
      }
    }
    // T031: re-resolve the entry at each run start (cheap, no network). The
    // ready cache is long, but the entry may have moved (a new version dir); a
    // changed entry invalidates the cache and re-probes before the run. Use the
    // same home and PATH as the prober, or a custom home would look changed.
    const fresh = resolveHarness(definition, {
      ...(this.home === undefined ? {} : { home: this.home }),
      ...(this.env?.PATH === undefined ? {} : { path: this.env.PATH }),
    })
    const cached = this.harnessEntry?.(payload.harness)
    const changed = cached !== undefined && (!fresh.ok || !sameEntry(cached, fresh.resolved))
    if (changed) {
      this.harnessFailed?.(payload.harness)
      const status = await withTimeout(
        this.harnessProbe?.(payload.harness) ?? Promise.resolve(undefined),
        this.probeWaitMs,
      )
      if (status !== "ready") {
        const code =
          status === "missing"
            ? "harness_missing"
            : status === "unauthenticated"
              ? "harness_unauthenticated"
              : "harness_unavailable"
        return { status: "failed", error: { code, message: `Harness is not ready: ${payload.harness}` } }
      }
    }
    const resolved = this.harnessEntry?.(payload.harness) ?? (fresh.ok ? fresh.resolved : undefined)
    if (!resolved) {
      return {
        status: "failed",
        error: {
          code: "harness_missing",
          message: `Harness is missing: ${payload.harness}${fresh.ok ? "" : ` (${fresh.reason})`}`,
        },
      }
    }

    // Re-entry for the same run: an equal or older generation is stale; a newer
    // generation fences the old runtime before it is replaced (N4.3, N4.4).
    for (let guard = 0; guard < 4; guard += 1) {
      const existing = this.active.get(command.runId)
      if (!existing) break
      if (command.generation <= (this.state.currentGeneration(command.runId) ?? 0)) {
        this.staleCount += 1
        return {
          status: "failed",
          error: { code: "fence_stale", message: "run.start generation is not newer than the active run" },
        }
      }
      existing.state = "fenced"
      await existing.run.cancel()
      if (this.active.get(command.runId) === existing) this.active.delete(command.runId)
    }
    const current = this.active.get(command.runId)
    if (current && command.generation <= (this.state.currentGeneration(command.runId) ?? 0)) {
      this.staleCount += 1
      return {
        status: "failed",
        error: { code: "fence_stale", message: "run.start generation is not newer than the active run" },
      }
    }
    // Monotonic: an older generation never replaces the stored one (FR-024).
    if (!this.state.advance(command.runId, command.generation)) {
      this.staleCount += 1
      return {
        status: "failed",
        error: { code: "fence_stale", message: "run.start generation is older than the recorded runtime" },
      }
    }

    // Every run is sandboxed (FR-001). There is no unsandboxed path: a sandbox
    // that cannot start fails the run instead of falling back. Unsafe entry
    // dirs degrade to file-only binds, so the argv builder does not throw.
    // Home and env come from the same source as the prober, so state binds and
    // entry resolution agree.
    const sandboxed = sandboxHarness(
      resolved.definition,
      profileFor(payload.harness),
      workspace,
      this.home,
      this.env,
      { entryDirs: resolved.dirs, entryFiles: resolved.files },
    )
    const run = this.runtime.run({
      harness: sandboxed,
      cwd: workspace,
      prompt: payload.prompt,
      ...(Array.isArray(payload.requires) ? { requires: payload.requires as Capability[] } : {}),
      ...(Array.isArray(payload.mcpServers) ? { mcpServers: payload.mcpServers as McpServer[] } : {}),
      signal: context.signal,
    })
    this.active.set(command.runId, { run, harness: payload.harness, state: "running" })
    try {
      for await (const event of run.events()) {
        const normalised = normaliseEvent(event, command.commandId)
        if (normalised) context.emit(normalised)
      }
      const outcome = outcomeOf(await run.result())
      // FR-021: a failed run invalidates the probe entry, so the next heartbeat
      // re-probes and a login is picked up without a restart.
      if (outcome.status === "failed") {
        this.harnessFailed?.(payload.harness)
        // FR-015: a sandbox that cannot start fails the run with its own code.
        // There is no unsandboxed retry and the profile never widens.
        if (sandboxFailed(run, outcome)) {
          return {
            status: "failed",
            error: { code: "isolation_unavailable", message: "Sandbox failed to start; no unsandboxed retry" },
          }
        }
      }
      return outcome
    } finally {
      // A newer generation may already own the entry; only the owner deletes it.
      if (this.active.get(command.runId)?.run === run) this.active.delete(command.runId)
    }
  }
}
