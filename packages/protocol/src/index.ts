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

/**
 * The only reason codes a probe may report. Defined once so the node and the
 * hub cannot drift; the hub rejects anything else.
 */
export const HARNESS_REPORT_REASONS = [
  "auth_required",
  "not_installed",
  "version_not_cached",
  "spawn_failed",
  "handshake_timeout",
  "process_exited",
  "protocol_unsupported",
  "capability_missing",
  "agent_error",
] as const

export type HarnessReportReason = (typeof HARNESS_REPORT_REASONS)[number]

export const HARNESS_REPORT_REASON_SET: ReadonlySet<string> = new Set(HARNESS_REPORT_REASONS)

export interface HarnessReport {
  id: string
  status: HarnessStatus
  reason?: HarnessReportReason
}

export interface IsolationReport {
  mode: "bwrap" | "sandbox-exec" | "none"
  profile: string
  selfTest: "pass" | "fail"
}

/**
 * The wire form of a profile version: a dotted number such as `1` or `1.2`.
 * Defined here so the node that sends it and the hub that validates it cannot
 * drift (contracts/isolation.md §5).
 */
export const ISOLATION_PROFILE_MAX_LENGTH = 11
export const ISOLATION_PROFILE_PATTERN = /^\d{1,3}(\.\d{1,3}){0,2}$/

/**
 * Bounds on node-supplied strings the hub stores (contracts/http-api.md
 * §heartbeat). A node is authenticated, but what it stores is still bounded.
 * The node applies the same limits before it dials, so an over-limit
 * advertisement fails at startup instead of silently dropping the node offline.
 */
export const NODE_HARNESSES_MAX_COUNT = 32
export const NODE_CAPABILITIES_MAX_COUNT = 32
export const NODE_STRING_MAX_LENGTH = 64
export const NODE_NAME_MAX_LENGTH = 64
export const NODE_LABELS_MAX_COUNT = 32
export const NODE_LABEL_MAX_LENGTH = 64
export const RUNTIME_TYPE_MAX_LENGTH = 64
export const RUNTIME_SESSION_ID_MAX_LENGTH = 256
export const RUNTIME_STATE_MAX_LENGTH = 64
export const RUNTIME_INVENTORY_MAX_COUNT = 1_000
export const HARNESS_REPORT_MAX_COUNT = 64
export const HARNESS_ID_MAX_LENGTH = 64

/** The `isolation.profile` string for a profile version number. */
export function isolationProfileVersion(version: number): string {
  return String(version)
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
  /** Last heartbeat's isolation report, verbatim. Additive and optional. */
  isolation?: IsolationReport
  lastHeartbeatAt: string | null
}
