/** Wire types shared by the hub and the node. One definition, so the two ends cannot drift. */

export const PROTOCOL_VERSION = 1
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1]

export type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "payload_too_large"
  | "forbidden"
  | "not_found"
  | "version_unsupported"
  | "idempotency_conflict"
  | "fence_stale"
  | "events_pending"
  | "lease_not_held"
  | "ambiguous_replay"
  | "capability_missing"
  | "no_eligible_node"
  | "recovery_precondition_failed"
  | "workspace_missing"
  | "internal"

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string }
}

export interface EnrollRequest {
  token: string
  name: string
  publicKey: string
  protocolVersion: number
  harnesses: string[]
  labels?: Record<string, string>
}

export interface EnrollResponse {
  nodeId: string
  protocolVersion: number
  heartbeatSeconds: number
}

export interface RuntimeInventoryEntry {
  runId: string
  generation: number
  runtimeType: string
  runtimeSessionId: string
  state: string
}

export interface HeartbeatRequest {
  protocolVersion: number
  status?: string
  harnesses: string[]
  capabilities?: string[]
  capacity?: { slots: number; inUse: number }
  runtimes?: RuntimeInventoryEntry[]
  /** Every probed harness, including the ones not advertised. Additive and optional. */
  harnessReport?: HarnessReport[]
  /** The sandbox the node runs harnesses in. Additive and optional. */
  isolation?: IsolationReport
}

export type HarnessStatus = "ready" | "missing" | "unauthenticated" | "unknown"

export interface HarnessReport {
  id: string
  status: HarnessStatus
  reason?: string
}

export interface IsolationReport {
  mode: "bwrap" | "sandbox-exec" | "none"
  profile: string
  selfTest: "pass" | "fail"
}

export interface HeartbeatResponse {
  status: string
  commandsPollMs: number
}

export type CommandType = "run.start" | "run.cancel" | "run.inspect"

export interface CommandPayload {
  fingerprint: string
  generation: number
  harness?: string
  cwd?: string
  prompt?: string
  requires?: string[]
  mcpServers?: unknown[]
  [key: string]: unknown
}

export interface CommandEnvelope {
  commandId: string
  type: CommandType
  runId: string
  generation: number
  idempotencyKey: string
  leasedUntil: string
  leaseId: string
  payload: CommandPayload
}

export interface RunEventInput {
  key: string
  type: string
  at: string
  data: unknown
}

export interface EventBatch {
  leaseId: string
  events: RunEventInput[]
}

export interface EventBatchResponse {
  accepted: number
  lastSeq: number
}

export interface CompletionRequest {
  leaseId: string
  status: "succeeded" | "failed"
  result?: unknown
  error?: { code: string; message: string }
  eventsToSeq?: number
}

export interface RunRequest {
  idempotencyKey: string
  harness: string
  prompt: string
  cwd?: string
  requires?: string[]
  mcpServers?: unknown[]
  nodeId?: string
  labels?: Record<string, string>
  /** Recovery needs a GIT-backed workspace. Defaults to true. */
  gitBacked?: boolean
}

export type RunStatus =
  | "queued"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "disconnected"

export interface RunView {
  runId: string
  status: RunStatus
  nodeId: string | null
  generation: number
  createdAt: string
  result?: unknown
  error?: { code: string; message: string } | null
  lastSeq?: number
}

export interface RunEventWire {
  seq: number
  key: string
  type: string
  at: string
  data: unknown
}

export interface NodeView {
  nodeId: string
  name: string
  status: string
  protocolVersion: number
  harnesses: string[]
  capabilities: string[]
  labels: Record<string, string>
  capacity: { slots: number; inUse: number }
  /** Last heartbeat's per-harness probe report, verbatim. Additive and optional. */
  harnessReport?: HarnessReport[]
  lastHeartbeatAt: string | null
}
