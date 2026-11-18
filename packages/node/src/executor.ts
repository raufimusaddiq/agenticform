import type { RunEventInput, RuntimeInventoryEntry } from "@agenticform/protocol"
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

/**
 * Executes hub commands through `runtime` (FR-019). The node owns no harness
 * logic: it maps a command to a runtime input and a runtime result to a
 * completion. Ledger durability is layered on top by a later task.
 */
export class Executor {
  private readonly runtime: Runtime
  private readonly active = new Map<string, ActiveRun>()
  private readonly state = new NodeState()
  private staleCount = 0

  constructor(options: ExecutorOptions = {}) {
    this.runtime = options.runtime ?? createRuntime()
  }

  get activeCount(): number {
    return this.active.size
  }

  /** Commands refused because their generation was older than the active run. */
  get staleObservations(): number {
    return this.staleCount
  }

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
    // FR-028: a reused command id with a different fingerprint is refused
    // before it can reach any handler or runtime.
    const admission = this.state.admit(command)
    if (admission === "conflict") {
      return {
        status: "failed",
        error: { code: "idempotency_conflict", message: "command id reused with a different fingerprint" },
      }
    }
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

    const run = this.runtime.run({
      harness: payload.harness,
      cwd: payload.cwd,
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
      return outcomeOf(await run.result())
    } finally {
      // A newer generation may already own the entry; only the owner deletes it.
      if (this.active.get(command.runId)?.run === run) this.active.delete(command.runId)
    }
  }
}
