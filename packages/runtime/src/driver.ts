import type {
  Capabilities,
  HarnessDefinition,
  McpServer,
  PermissionDecision,
  PermissionRequest,
  StopReason,
} from "./types.ts"

export type DriverEvent =
  | { type: "message.delta"; text: string }
  | { type: "thought.delta"; text: string }
  | { type: "tool.call"; toolCallId: string; title: string | null; kind: string | null; status: string | null }
  | { type: "tool.update"; toolCallId: string; title: string | null; status: string | null }
  | { type: "plan"; entries: readonly { content: string; status: string }[] }
  | { type: "permission.requested"; request: PermissionRequest }
  | { type: "permission.resolved"; toolCallId: string; decision: PermissionDecision | "cancelled" }
  | { type: "other"; updateType: string }

export interface DriverSink {
  emit(event: DriverEvent): void
  decide(request: PermissionRequest): Promise<PermissionDecision>
}

export interface ConnectInput {
  harness: HarnessDefinition
  cwd: string
  env: Readonly<Record<string, string>>
}

/** One supervised agent process. Non-ACP drivers implement the same boundary. */
export interface DriverConnection {
  readonly capabilities: Capabilities
  openSession(input: { cwd: string; mcpServers: readonly McpServer[] }): Promise<void>
  /** Resolves when the turn ends. Rejects with RuntimeError if the agent fails or exits. */
  prompt(text: string): Promise<{ stopReason: StopReason }>
  cancel(): Promise<void>
  /** Stops the process and everything it started. Safe to call more than once. */
  close(): Promise<void>
  stderrTail(): string
}

export interface RuntimeDriver {
  connect(input: ConnectInput, sink: DriverSink, signal: AbortSignal): Promise<DriverConnection>
}
