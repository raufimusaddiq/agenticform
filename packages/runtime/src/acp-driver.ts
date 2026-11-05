import { spawn, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import type { ConnectInput, DriverConnection, DriverSink, RuntimeDriver } from "./driver.ts"
import { RuntimeError, type Capabilities, type McpServer, type StopReason } from "./types.ts"

const AUTH_REQUIRED = -32000
const STDERR_TAIL_BYTES = 8192
const TERM_GRACE_MS = 2000
const EXIT_REPORT_WAIT_MS = 1000

const text = (block: { type: string; text?: string }): string | null =>
  block.type === "text" && typeof block.text === "string" ? block.text : null

function waitForSpawn(child: ChildProcess, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", (error) => reject(new RuntimeError("spawn_failed", `Could not start ${command}: ${error.message}`)))
  })
}

function toCapabilities(response: acp.InitializeResponse): Capabilities {
  const agent = response.agentCapabilities ?? {}
  return {
    protocolVersion: response.protocolVersion,
    agent: response.agentInfo ? { name: response.agentInfo.name, version: response.agentInfo.version } : null,
    supported: {
      cancel: true,
      "steer.emulated": true,
      "mcp.stdio": true,
      "mcp.http": agent.mcpCapabilities?.http === true,
      "mcp.sse": agent.mcpCapabilities?.sse === true,
      "session.load": agent.loadSession === true,
      "session.resume": agent.sessionCapabilities?.resume != null,
      "prompt.image": agent.promptCapabilities?.image === true,
      "prompt.embeddedContext": agent.promptCapabilities?.embeddedContext === true,
    },
  }
}

class AcpConnection implements DriverConnection {
  capabilities!: Capabilities
  private context!: acp.ClientContext
  private sessionId: string | null = null
  private stderr = ""
  private closing: Promise<void> | null = null
  private releaseConnection!: () => void
  private readonly pendingPermissions = new Set<() => void>()
  private readonly exited: Promise<void>
  private exitedFlag = false

  constructor(
    private readonly child: ChildProcess,
    private readonly sink: DriverSink,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("close", () => {
        this.exitedFlag = true
        resolve()
      })
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES)
    })
    child.stdin?.on("error", () => {})
  }

  async start(signal: AbortSignal): Promise<void> {
    const app = acp
      .client({ name: "agenticform" })
      .onNotification(acp.methods.client.session.update, ({ params }) => this.onUpdate(params))
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.onPermission(params))

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
    )

    const connected = new Promise<acp.ClientContext>((resolve, reject) => {
      app
        .connectWith(stream, (context) => {
          resolve(context)
          return new Promise<void>((release) => {
            this.releaseConnection = release
          })
        })
        .catch(reject)
    })
    // The run outcome comes from the awaited calls below; a late stream error adds nothing.
    connected.catch(() => {})

    this.context = await this.orExit(connected, signal)
    const response = await this.orExit(
      this.context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agenticform", version: "0.1.0" },
      }),
      signal,
    )
    if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new RuntimeError("protocol_unsupported", `Agent negotiated ACP version ${response.protocolVersion}`)
    }
    this.capabilities = toCapabilities(response)
  }

  /** Stops waiting when the process exits, because its pending replies will never arrive. */
  private async orExit<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return
      onAbort = () => reject(signal.reason)
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    })
    const exited = this.exited.then(() => {
      throw new RuntimeError("process_exited", "Agent process exited")
    })
    try {
      return await Promise.race([work, exited, aborted])
    } catch (error) {
      if (error instanceof RuntimeError || error instanceof acp.RequestError) throw error
      // A closed stream can reject pending requests just before the process reports its exit.
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, EXIT_REPORT_WAIT_MS))])
      if (this.exitedFlag) throw new RuntimeError("process_exited", "Agent process exited")
      throw error
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort)
    }
  }

  async openSession(input: { cwd: string; mcpServers: readonly McpServer[] }): Promise<void> {
    try {
      const response = await this.orExit(
        this.context.request(acp.methods.agent.session.new, {
          cwd: input.cwd,
          mcpServers: [...input.mcpServers] as acp.McpServer[],
        }),
      )
      this.sessionId = response.sessionId
    } catch (error) {
      if (error instanceof acp.RequestError && error.code === AUTH_REQUIRED) {
        throw new RuntimeError("auth_required", "The harness needs authentication on this machine")
      }
      throw this.asRuntimeError(error)
    }
  }

  async prompt(prompt: string): Promise<{ stopReason: StopReason }> {
    try {
      const response = await this.orExit(
        this.context.request(acp.methods.agent.session.prompt, {
          sessionId: this.sessionId!,
          prompt: [{ type: "text", text: prompt }],
        }),
      )
      return { stopReason: response.stopReason }
    } catch (error) {
      throw this.asRuntimeError(error)
    }
  }

  private asRuntimeError(error: unknown): RuntimeError {
    if (error instanceof RuntimeError) return error
    return new RuntimeError("agent_error", error instanceof Error ? error.message : "Agent request failed")
  }

  async cancel(): Promise<void> {
    for (const release of this.pendingPermissions) release()
    if (this.sessionId && !this.exitedFlag) {
      await this.context.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => {})
    }
  }

  private onUpdate(params: acp.SessionNotification): void {
    if (this.sessionId && params.sessionId !== this.sessionId) return
    const update = params.update
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const value = text(update.content)
        const type = update.sessionUpdate === "agent_message_chunk" ? "message.delta" : "thought.delta"
        if (value === null) this.sink.emit({ type: "other", updateType: update.sessionUpdate })
        else this.sink.emit({ type, text: value })
        return
      }
      case "tool_call":
        this.sink.emit({
          type: "tool.call",
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind ?? null,
          status: update.status ?? null,
        })
        return
      case "tool_call_update":
        this.sink.emit({
          type: "tool.update",
          toolCallId: update.toolCallId,
          title: update.title ?? null,
          status: update.status ?? null,
        })
        return
      case "plan":
        this.sink.emit({
          type: "plan",
          entries: update.entries.map((entry) => ({ content: entry.content, status: entry.status })),
        })
        return
      default:
        this.sink.emit({ type: "other", updateType: String(update.sessionUpdate) })
    }
  }

  private async onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const request = {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? null,
      kind: params.toolCall.kind ?? null,
    }
    this.sink.emit({ type: "permission.requested", request })

    let release!: () => void
    const cancelled = new Promise<"cancelled">((resolve) => {
      release = () => resolve("cancelled")
      this.pendingPermissions.add(release)
    })
    const decision = await Promise.race([this.sink.decide(request), cancelled]).finally(() =>
      this.pendingPermissions.delete(release),
    )
    if (decision === "cancelled") {
      this.sink.emit({ type: "permission.resolved", toolCallId: request.toolCallId, decision })
      return { outcome: { outcome: "cancelled" } }
    }

    // Only a one-time grant is ever selected: "allow always" outlives this run.
    const wanted: acp.PermissionOptionKind[] = decision === "allow" ? ["allow_once"] : ["reject_once", "reject_always"]
    const option = wanted.map((kind) => params.options.find((item) => item.kind === kind)).find(Boolean)
    if (option) {
      this.sink.emit({ type: "permission.resolved", toolCallId: request.toolCallId, decision })
      return { outcome: { outcome: "selected", optionId: option.optionId } }
    }
    const fallback = params.options.find((item) => item.kind === "reject_once" || item.kind === "reject_always")
    this.sink.emit({
      type: "permission.resolved",
      toolCallId: request.toolCallId,
      decision: fallback ? "deny" : "cancelled",
    })
    return fallback
      ? { outcome: { outcome: "selected", optionId: fallback.optionId } }
      : { outcome: { outcome: "cancelled" } }
  }

  close(): Promise<void> {
    this.closing ??= this.stop()
    return this.closing
  }

  private async stop(): Promise<void> {
    this.releaseConnection?.()
    const signalGroup = (name: NodeJS.Signals) => {
      try {
        // The child leads its own process group, so wrappers such as bunx take their children with them.
        if (this.child.pid) process.kill(-this.child.pid, name)
      } catch {
        // The group is already gone.
      }
    }
    signalGroup("SIGTERM")
    const stopped = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TERM_GRACE_MS)),
    ])
    // A leader that exits first can leave children behind, so the group always gets the final signal.
    signalGroup("SIGKILL")
    if (!stopped) await this.exited
  }

  stderrTail(): string {
    return this.stderr
  }
}

export class AcpDriver implements RuntimeDriver {
  async connect(input: ConnectInput, sink: DriverSink, signal: AbortSignal): Promise<DriverConnection> {
    const child = spawn(input.harness.command, [...(input.harness.args ?? [])], {
      cwd: input.cwd,
      env: { ...process.env, ...input.harness.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    })
    const spawned = waitForSpawn(child, input.harness.command)
    const connection = new AcpConnection(child, sink)
    await spawned
    try {
      await connection.start(signal)
    } catch (error) {
      await connection.close()
      throw error
    }
    return connection
  }
}
