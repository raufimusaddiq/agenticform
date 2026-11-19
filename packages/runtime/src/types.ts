export type HarnessProfile = "coding" | "agentic"

/** `tested` is earned only by passing the conformance suite at a recorded version. */
export type VerificationLevel = "documented" | "tested"

/**
 * A harness-owned login check, declared as data. The node runs it as a child
 * inside the same sandbox a run uses and keeps one boolean: the JSON field named
 * by `loggedIn`. The node never opens a credential file itself.
 */
export interface AuthCheck {
  /** Candidate executables, relative to the cached package's `node_modules` or an entry dir. */
  bin: readonly string[]
  args: readonly string[]
  /** Top-level boolean field of the JSON on stdout. */
  loggedIn: string
}

export interface HarnessDefinition {
  id: string
  profile: HarnessProfile
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  verification?: VerificationLevel
  notes?: string
  authCheck?: AuthCheck
}

export type Capability =
  | "cancel"
  | "steer.emulated"
  | "mcp.stdio"
  | "mcp.http"
  | "mcp.sse"
  | "session.load"
  | "session.resume"
  | "prompt.image"
  | "prompt.embeddedContext"

export interface Capabilities {
  protocolVersion: number
  agent: { name: string; version: string } | null
  supported: Readonly<Record<Capability, boolean>>
}

export type McpServer =
  | { type?: "stdio"; name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http" | "sse"; name: string; url: string; headers: { name: string; value: string }[] }

export interface PermissionRequest {
  toolCallId: string
  title: string | null
  kind: string | null
}

export type PermissionDecision = "allow" | "deny"
export type PermissionHandler = (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>

export type ErrorCode =
  | "invalid_input"
  | "unknown_harness"
  | "spawn_failed"
  | "handshake_timeout"
  | "protocol_unsupported"
  | "capability_missing"
  | "auth_required"
  | "process_exited"
  | "agent_error"

export class RuntimeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "RuntimeError"
  }
}

/** How a run answers harness permission requests. The sandbox is the boundary, so the default is "allow". */
export type PermissionPolicy = "allow" | "ask" | "deny"
export const permissionPolicies: readonly PermissionPolicy[] = ["allow", "ask", "deny"]

export interface RunInput {
  harness: string | HarnessDefinition
  cwd: string
  prompt: string
  requires?: readonly Capability[]
  mcpServers?: readonly McpServer[]
  env?: Readonly<Record<string, string>>
  /** Default "allow": requests are allowed without calling onPermission. "ask" uses onPermission; "deny" refuses all. */
  permissionPolicy?: PermissionPolicy
  /** Only used when permissionPolicy is "ask"; an "ask" run with no handler denies. */
  onPermission?: PermissionHandler
  signal?: AbortSignal
  /** Limit for spawn, handshake and session creation. Default 60s. */
  handshakeTimeoutMs?: number
  /** How long a cancelled agent may keep running before it is stopped. Default 10s. */
  cancelGraceMs?: number
  /** Under policy "ask", an unanswered permission request is denied after this long. Default 300s. */
  permissionTimeoutMs?: number
}

export type RunStatus = "completed" | "incomplete" | "cancelled" | "failed"
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"

export interface RunFailure {
  code: ErrorCode
  message: string
}

export interface RunResult {
  runId: string
  status: RunStatus
  stopReason: StopReason | null
  /** Text of the final turn. */
  text: string
  error: RunFailure | null
}

type EventBody =
  | { type: "run.started"; harness: string; profile: HarnessProfile }
  | { type: "run.capabilities"; capabilities: Capabilities }
  | { type: "turn.started"; turnId: string; steered: boolean; emulated: boolean }
  | { type: "message.delta"; turnId: string; text: string }
  | { type: "thought.delta"; turnId: string; text: string }
  | { type: "tool.call"; turnId: string; toolCallId: string; title: string | null; kind: string | null; status: string | null }
  | { type: "tool.update"; turnId: string; toolCallId: string; title: string | null; status: string | null }
  | { type: "plan"; turnId: string; entries: readonly { content: string; status: string }[] }
  | { type: "permission.requested"; turnId: string; request: PermissionRequest }
  | { type: "permission.resolved"; turnId: string; toolCallId: string; decision: PermissionDecision | "cancelled" }
  | { type: "turn.finished"; turnId: string; stopReason: StopReason }
  | { type: "other"; turnId: string | null; updateType: string }
  | { type: "run.finished"; result: RunResult }

export type RunEventBody = EventBody
export type RunEvent = EventBody & { runId: string; seq: number; at: string }
