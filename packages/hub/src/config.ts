import { join } from "node:path"

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
}

const seconds = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : Number(value) * 1000

const millis = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : Number(value)

export function loadConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const stateDir = env.AGENTICFORM_STATE_DIR ?? join(process.env.HOME ?? ".", ".agenticform-hub")
  const config: HubConfig = {
    adminToken: env.AGENTICFORM_ADMIN_TOKEN ?? "",
    publicUrl: env.AGENTICFORM_HUB_URL ?? null,
    stateFile: env.AGENTICFORM_HUB_DB ?? join(stateDir, "hub.sqlite"),
    port: Number(env.AGENTICFORM_HUB_PORT ?? 8787),
    clockSkewMs: seconds(env.AGENTICFORM_CLOCK_SKEW_SECONDS, 120_000),
    heartbeatIntervalMs: seconds(env.AGENTICFORM_HEARTBEAT_SECONDS, 15_000),
    nodeOfflineMs: seconds(env.AGENTICFORM_NODE_OFFLINE_SECONDS, 45_000),
    enrollmentTtlMs: seconds(env.AGENTICFORM_ENROLLMENT_TTL_SECONDS, 600_000),
    nonceTtlMs: seconds(env.AGENTICFORM_NONCE_TTL_SECONDS, 600_000),
    nonceCleanupMs: seconds(env.AGENTICFORM_NONCE_CLEANUP_SECONDS, 600_000),
    leaseMs: seconds(env.AGENTICFORM_LEASE_SECONDS, 900_000),
    pollMs: millis(env.AGENTICFORM_POLL_MS, 1_500),
    recoveryGraceMs: seconds(env.AGENTICFORM_RECOVERY_GRACE_SECONDS, 120_000),
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
    ["AGENTICFORM_HUB_PORT", config.port],
    ["AGENTICFORM_CLOCK_SKEW_SECONDS", config.clockSkewMs],
    ["AGENTICFORM_HEARTBEAT_SECONDS", config.heartbeatIntervalMs],
    ["AGENTICFORM_NODE_OFFLINE_SECONDS", config.nodeOfflineMs],
    ["AGENTICFORM_ENROLLMENT_TTL_SECONDS", config.enrollmentTtlMs],
    ["AGENTICFORM_NONCE_TTL_SECONDS", config.nonceTtlMs],
    ["AGENTICFORM_NONCE_CLEANUP_SECONDS", config.nonceCleanupMs],
    ["AGENTICFORM_LEASE_SECONDS", config.leaseMs],
    ["AGENTICFORM_POLL_MS", config.pollMs],
    ["AGENTICFORM_RECOVERY_GRACE_SECONDS", config.recoveryGraceMs],
  ]
  for (const [name, value] of numbers) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  }
  if (!Number.isInteger(config.port) || config.port > 65_535) {
    throw new Error("AGENTICFORM_HUB_PORT must be an integer between 1 and 65535")
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
