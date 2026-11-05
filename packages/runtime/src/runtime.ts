import { isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { AcpDriver } from "./acp-driver.ts"
import type { DriverConnection, DriverEvent, DriverSink, RuntimeDriver } from "./driver.ts"
import { EventLog } from "./event-log.ts"
import { harnesses as builtInHarnesses } from "./harnesses.ts"
import {
  RuntimeError,
  type Capabilities,
  type Capability,
  type HarnessDefinition,
  type PermissionDecision,
  type PermissionRequest,
  type RunEvent,
  type RunInput,
  type RunResult,
  type RunStatus,
  type StopReason,
} from "./types.ts"

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000
const DEFAULT_CANCEL_GRACE_MS = 10_000
const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000

function statusOf(stopReason: StopReason): RunStatus {
  if (stopReason === "end_turn") return "completed"
  if (stopReason === "cancelled") return "cancelled"
  return "incomplete"
}

export class Run {
  readonly id = randomUUID()
  private readonly log = new EventLog(this.id)
  private readonly settled: Promise<RunResult>
  private readonly aborter = new AbortController()
  private connection: DriverConnection | null = null
  private turnId: string | null = null
  private turnText = ""
  private nextPrompt: string | null = null
  private cancelRequested = false
  private finished = false
  private graceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly input: RunInput,
    private readonly harness: HarnessDefinition | null,
    private readonly harnessError: RuntimeError | null,
    private readonly driver: RuntimeDriver,
  ) {
    this.settled = this.execute()
  }

  events(): AsyncGenerator<RunEvent> {
    return this.log.read()
  }

  result(): Promise<RunResult> {
    return this.settled
  }

  get capabilities(): Capabilities | null {
    return this.connection?.capabilities ?? null
  }

  /** Recent agent stderr, for local debugging. It may contain sensitive output, so it never enters events. */
  stderrTail(): string {
    return this.connection?.stderrTail() ?? ""
  }

  async cancel(): Promise<void> {
    if (this.finished) return
    this.cancelRequested = true
    this.nextPrompt = null
    this.aborter.abort(new DOMException("Run cancelled", "AbortError"))
    await this.interrupt()
  }

  /** Emulated: cancels the current turn, then continues the session with a new prompt. */
  async steer(prompt: string): Promise<void> {
    if (this.finished || this.cancelRequested) {
      throw new RuntimeError("invalid_input", "This run is no longer active")
    }
    if (!this.connection || !this.turnId) {
      throw new RuntimeError("invalid_input", "This run has no active turn to steer")
    }
    this.nextPrompt = prompt
    await this.interrupt()
  }

  private async interrupt(): Promise<void> {
    const connection = this.connection
    if (!connection) return
    await connection.cancel()
    clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(
      () => void connection.close(),
      this.input.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    )
  }

  private emit(event: DriverEvent): void {
    if (event.type === "message.delta") this.turnText += event.text
    if (event.type === "other") this.log.append({ ...event, turnId: this.turnId })
    else this.log.append({ ...event, turnId: this.turnId ?? "" })
  }

  private async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const handler = this.input.onPermission
    if (!handler) return "deny"
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<PermissionDecision>((resolve) => {
      timer = setTimeout(() => resolve("deny"), this.input.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS)
    })
    try {
      const decision = await Promise.race([handler(request), timeout])
      return decision === "allow" ? "allow" : "deny"
    } catch {
      return "deny"
    } finally {
      clearTimeout(timer)
    }
  }

  private async connect(harness: HarnessDefinition): Promise<DriverConnection> {
    const sink: DriverSink = { emit: (event) => this.emit(event), decide: (request) => this.decide(request) }
    const limit = this.input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    const stop = new AbortController()
    const abort = () => stop.abort(this.aborter.signal.reason)
    this.aborter.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(
      () => stop.abort(new RuntimeError("handshake_timeout", `No handshake from ${harness.id} within ${limit}ms`)),
      limit,
    )
    try {
      return await this.driver.connect(
        { harness, cwd: this.input.cwd, env: this.input.env ?? {} },
        sink,
        stop.signal,
      )
    } finally {
      clearTimeout(timer)
      this.aborter.signal.removeEventListener("abort", abort)
    }
  }

  private async openSession(connection: DriverConnection, harness: HarnessDefinition): Promise<void> {
    const limit = this.input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void connection.close()
    }, limit)
    try {
      await connection.openSession({ cwd: this.input.cwd, mcpServers: this.input.mcpServers ?? [] })
    } catch (cause) {
      if (timedOut) throw new RuntimeError("handshake_timeout", `No session from ${harness.id} within ${limit}ms`)
      throw cause
    } finally {
      clearTimeout(timer)
    }
  }

  private checkRequirements(capabilities: Capabilities): void {
    const needed = new Set<Capability>(this.input.requires ?? [])
    for (const server of this.input.mcpServers ?? []) {
      if (server.type === "http") needed.add("mcp.http")
      if (server.type === "sse") needed.add("mcp.sse")
    }
    const missing = [...needed].filter((capability) => !capabilities.supported[capability])
    if (missing.length > 0) {
      throw new RuntimeError("capability_missing", `Missing capability: ${missing.join(", ")}`)
    }
  }

  private async turns(connection: DriverConnection): Promise<StopReason> {
    let prompt = this.input.prompt
    let steered = false
    while (true) {
      this.turnId = randomUUID()
      this.turnText = ""
      this.log.append({ type: "turn.started", turnId: this.turnId, steered, emulated: steered })
      const { stopReason } = await connection.prompt(prompt)
      clearTimeout(this.graceTimer)
      this.log.append({ type: "turn.finished", turnId: this.turnId, stopReason })
      if (this.nextPrompt === null) return stopReason
      prompt = this.nextPrompt
      this.nextPrompt = null
      steered = true
    }
  }

  private async execute(): Promise<RunResult> {
    // The constructor must finish before work starts, so callers can attach to the run.
    await Promise.resolve()
    const signal = this.input.signal
    const onAbort = () => void this.cancel()
    let stopReason: StopReason | null = null
    let status: RunStatus = "failed"
    let error: RunResult["error"] = null

    try {
      if (this.harnessError) throw this.harnessError
      if (!isAbsolute(this.input.cwd)) throw new RuntimeError("invalid_input", "cwd must be an absolute path")
      if (!this.input.prompt) throw new RuntimeError("invalid_input", "prompt must not be empty")
      const harness = this.harness!
      this.log.append({ type: "run.started", harness: harness.id, profile: harness.profile })

      if (signal?.aborted) {
        await this.cancel()
      } else {
        signal?.addEventListener("abort", onAbort, { once: true })
      }
      this.aborter.signal.throwIfAborted()

      const connection = await this.connect(harness)
      this.connection = connection
      this.log.append({ type: "run.capabilities", capabilities: connection.capabilities })
      this.checkRequirements(connection.capabilities)
      this.aborter.signal.throwIfAborted()
      await this.openSession(connection, harness)
      this.aborter.signal.throwIfAborted()
      stopReason = await this.turns(connection)
      status = statusOf(stopReason)
    } catch (cause) {
      if (this.cancelRequested) {
        status = "cancelled"
      } else {
        const failure =
          cause instanceof RuntimeError
            ? cause
            : new RuntimeError("agent_error", cause instanceof Error ? cause.message : "Run failed")
        error = { code: failure.code, message: failure.message }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
      clearTimeout(this.graceTimer)
      await this.connection?.close()
    }

    this.finished = true
    const result: RunResult = { runId: this.id, status, stopReason, text: this.turnText, error }
    this.log.append({ type: "run.finished", result })
    this.log.close()
    return result
  }
}

export interface RuntimeOptions {
  /** Added to, and able to replace, the built-in harness catalog. */
  harnesses?: Readonly<Record<string, HarnessDefinition>>
  driver?: RuntimeDriver
}

export class Runtime {
  private readonly catalog: Readonly<Record<string, HarnessDefinition>>
  private readonly driver: RuntimeDriver

  constructor(options: RuntimeOptions = {}) {
    this.catalog = { ...builtInHarnesses, ...options.harnesses }
    this.driver = options.driver ?? new AcpDriver()
  }

  harnesses(): HarnessDefinition[] {
    return Object.values(this.catalog)
  }

  run(input: RunInput): Run {
    const harness = typeof input.harness === "string" ? this.catalog[input.harness] : input.harness
    const error = harness ? null : new RuntimeError("unknown_harness", `Unknown harness: ${String(input.harness)}`)
    return new Run(input, harness ?? null, error, this.driver)
  }
}

export const createRuntime = (options?: RuntimeOptions): Runtime => new Runtime(options)
