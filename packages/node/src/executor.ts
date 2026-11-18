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
  generation: number
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

  constructor(options: ExecutorOptions = {}) {
    this.runtime = options.runtime ?? createRuntime()
  }

  get activeCount(): number {
    return this.active.size
  }

  harnesses(): string[] {
    return this.runtime.harnesses().map((harness) => harness.id)
  }

  inventory(): RuntimeInventoryEntry[] {
    return [...this.active.entries()].map(([runId, active]) => ({
      runId,
      generation: active.generation,
      runtimeType: active.harness,
      runtimeSessionId: "",
      state: active.state,
    }))
  }

  async execute(command: CommandEnvelope, context: ExecutionContext): Promise<ExecutionOutcome> {
    if (command.type === "run.cancel") return this.cancel(command.runId)
    if (command.type === "run.inspect") return this.inspect(command.runId)
    return this.start(command, context)
  }

  async cancel(runId: string): Promise<ExecutionOutcome> {
    const active = this.active.get(runId)
    if (active) {
      active.state = "cancelling"
      await active.run.cancel()
    }
    return { status: "succeeded", result: { status: "cancelled" } }
  }

  inspect(runId: string): ExecutionOutcome {
    const active = this.active.get(runId)
    return {
      status: "succeeded",
      result: {
        status: "completed",
        runId,
        state: active?.state ?? "absent",
        generation: active?.generation ?? null,
      },
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((active) => active.run.cancel()))
  }

  private async start(command: CommandEnvelope, context: ExecutionContext): Promise<ExecutionOutcome> {
    const payload = command.payload
    // FR-021: a payload generation that disagrees with the envelope is refused
    // before the runtime is touched.
    if (payload.generation !== command.generation) {
      return {
        status: "failed",
        error: { code: "fence_stale", message: "payload generation differs from envelope" },
      }
    }
    if (typeof payload.harness !== "string" || !payload.harness) {
      return { status: "failed", error: { code: "invalid_input", message: "harness is required" } }
    }
    if (typeof payload.cwd !== "string" || !payload.cwd) {
      return { status: "failed", error: { code: "invalid_input", message: "cwd is required" } }
    }
    if (typeof payload.prompt !== "string" || !payload.prompt) {
      return { status: "failed", error: { code: "invalid_input", message: "prompt is required" } }
    }

    const run = this.runtime.run({
      harness: payload.harness,
      cwd: payload.cwd,
      prompt: payload.prompt,
      ...(Array.isArray(payload.requires) ? { requires: payload.requires as Capability[] } : {}),
      ...(Array.isArray(payload.mcpServers) ? { mcpServers: payload.mcpServers as McpServer[] } : {}),
      signal: context.signal,
    })
    this.active.set(command.runId, {
      run,
      generation: command.generation,
      harness: payload.harness,
      state: "running",
    })
    try {
      for await (const event of run.events()) {
        const normalised = normaliseEvent(event, command.commandId)
        if (normalised) context.emit(normalised)
      }
      return outcomeOf(await run.result())
    } finally {
      this.active.delete(command.runId)
    }
  }
}
