import { join } from "node:path"
import { loadConfigFile } from "@agenticform/protocol/config"

export interface HubConfig {
  adminToken: string
  publicUrl: string | null
  stateFile: string
  port: number
  clockSkewMs: number
  heartbeatIntervalMs: number
  nodeOfflineMs: number
  enrollmentTtlMs: number
  nonceTtlMs: number
  nonceCleanupMs: number
  leaseMs: number
  pollMs: number
  recoveryGraceMs: number
  maxBodyBytes: number
  maxDepth: number
  workflowTimeoutMs: number
  workflowMaxOutputBytes: number
  workflowMaxSnapshotBytes: number
  workflowMaxChildRuns: number
  workflowMaxCodeBytes: number
  workflowParkMs: number
}

const seconds = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : Number(value) * 1000

const millis = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : Number(value)

export function loadConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const file = loadConfigFile(env)
  const stateDir =
    env.AGENTICFORM_STATE_DIR ?? file.hub?.stateDir ?? join(env.HOME ?? ".", ".agenticform-hub")
  const config: HubConfig = {
    adminToken: env.AGENTICFORM_ADMIN_TOKEN ?? file.adminToken ?? "",
    publicUrl: env.AGENTICFORM_HUB_URL ?? file.hub?.publicUrl ?? null,
    stateFile: env.AGENTICFORM_HUB_DB ?? file.hub?.dbPath ?? join(stateDir, "hub.sqlite"),
    port: Number(env.AGENTICFORM_HUB_PORT ?? file.hub?.port ?? 8787),
    clockSkewMs: seconds(env.AGENTICFORM_CLOCK_SKEW_SECONDS, 120_000),
    heartbeatIntervalMs: seconds(env.AGENTICFORM_HEARTBEAT_SECONDS, 15_000),
    nodeOfflineMs: seconds(env.AGENTICFORM_NODE_OFFLINE_SECONDS, 45_000),
    enrollmentTtlMs: seconds(env.AGENTICFORM_ENROLLMENT_TTL_SECONDS, 600_000),
    nonceTtlMs: seconds(env.AGENTICFORM_NONCE_TTL_SECONDS, 600_000),
    nonceCleanupMs: seconds(env.AGENTICFORM_NONCE_CLEANUP_SECONDS, 600_000),
    leaseMs: seconds(env.AGENTICFORM_LEASE_SECONDS, 900_000),
    pollMs: millis(env.AGENTICFORM_POLL_MS, 1_500),
    recoveryGraceMs: seconds(env.AGENTICFORM_RECOVERY_GRACE_SECONDS, 120_000),
    maxBodyBytes: millis(env.AGENTICFORM_MAX_BODY_BYTES, 1_048_576),
    maxDepth: millis(env.AGENTICFORM_RUN_MAX_DEPTH, file.hub?.maxDepth ?? 3),
    workflowTimeoutMs: millis(
      env.AGENTICFORM_WORKFLOW_TIMEOUT_MS,
      file.hub?.workflowTimeoutMs ?? 30_000,
    ),
    workflowMaxOutputBytes: millis(env.AGENTICFORM_WORKFLOW_MAX_OUTPUT_BYTES, 65_536),
    workflowMaxSnapshotBytes: millis(env.AGENTICFORM_WORKFLOW_MAX_SNAPSHOT_BYTES, 524_288),
    workflowMaxChildRuns: millis(
      env.AGENTICFORM_WORKFLOW_MAX_CHILD_RUNS,
      file.hub?.workflowMaxChildRuns ?? 20,
    ),
    workflowMaxCodeBytes: millis(env.AGENTICFORM_WORKFLOW_MAX_CODE_BYTES, 65_536),
    workflowParkMs: millis(env.AGENTICFORM_WORKFLOW_PARK_MS, 50),
  }
  validateConfig(config)
  return config
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/** Startup fails closed on unsafe configuration (FR-015, N8.2). */
export function validateConfig(config: HubConfig): void {
  if (config.adminToken.length < 32) {
    throw new Error("AGENTICFORM_ADMIN_TOKEN must be at least 32 characters")
  }
  const numbers: [string, number][] = [
    ["AGENTICFORM_CLOCK_SKEW_SECONDS", config.clockSkewMs],
    ["AGENTICFORM_HEARTBEAT_SECONDS", config.heartbeatIntervalMs],
    ["AGENTICFORM_NODE_OFFLINE_SECONDS", config.nodeOfflineMs],
    ["AGENTICFORM_ENROLLMENT_TTL_SECONDS", config.enrollmentTtlMs],
    ["AGENTICFORM_NONCE_TTL_SECONDS", config.nonceTtlMs],
    ["AGENTICFORM_NONCE_CLEANUP_SECONDS", config.nonceCleanupMs],
    ["AGENTICFORM_LEASE_SECONDS", config.leaseMs],
    ["AGENTICFORM_POLL_MS", config.pollMs],
    ["AGENTICFORM_RECOVERY_GRACE_SECONDS", config.recoveryGraceMs],
    ["AGENTICFORM_MAX_BODY_BYTES", config.maxBodyBytes],
    ["AGENTICFORM_WORKFLOW_TIMEOUT_MS", config.workflowTimeoutMs],
    ["AGENTICFORM_WORKFLOW_MAX_SNAPSHOT_BYTES", config.workflowMaxSnapshotBytes],
    ["AGENTICFORM_WORKFLOW_MAX_CODE_BYTES", config.workflowMaxCodeBytes],
    ["AGENTICFORM_WORKFLOW_PARK_MS", config.workflowParkMs],
  ]
  for (const [name, value] of numbers) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new Error("AGENTICFORM_HUB_PORT must be an integer between 0 and 65535")
  }
  if (!Number.isInteger(config.maxDepth) || config.maxDepth < 0) {
    throw new Error("AGENTICFORM_RUN_MAX_DEPTH must be a non-negative integer")
  }
  if (!Number.isInteger(config.workflowMaxOutputBytes) || config.workflowMaxOutputBytes < 0) {
    throw new Error("AGENTICFORM_WORKFLOW_MAX_OUTPUT_BYTES must be a non-negative integer")
  }
  if (!Number.isInteger(config.workflowMaxChildRuns) || config.workflowMaxChildRuns < 0) {
    throw new Error("AGENTICFORM_WORKFLOW_MAX_CHILD_RUNS must be a non-negative integer")
  }
  if (config.nonceTtlMs < 2 * config.clockSkewMs + 60_000) {
    throw new Error(
      "AGENTICFORM_NONCE_TTL_SECONDS must be at least twice AGENTICFORM_CLOCK_SKEW_SECONDS plus 60",
    )
  }
  if (config.nodeOfflineMs <= config.heartbeatIntervalMs) {
    throw new Error("AGENTICFORM_NODE_OFFLINE_SECONDS must exceed AGENTICFORM_HEARTBEAT_SECONDS")
  }
  if (config.publicUrl === null) return
  let url: URL
  try {
    url = new URL(config.publicUrl)
  } catch {
    throw new Error("AGENTICFORM_HUB_URL must be an absolute URL")
  }
  if (url.username || url.password) throw new Error("AGENTICFORM_HUB_URL must not carry credentials")
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("AGENTICFORM_HUB_URL must be a clean origin")
  if (url.search || url.hash) throw new Error("AGENTICFORM_HUB_URL must be a clean origin")
  if (!LOOPBACK.has(url.hostname) && url.protocol !== "https:") {
    throw new Error("AGENTICFORM_HUB_URL must use HTTPS for a non-local host")
  }
}
