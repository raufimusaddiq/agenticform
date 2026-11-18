import { join } from "node:path"

export interface NodeConfig {
  hubUrl: string
  stateDir: string
  heartbeatIntervalMs: number
  pollMs: number
  leaseRenewMs: number
  requestTimeoutMs: number
  harnessProbeTtlMs: number
  harnessProbeTimeoutMs: number
  protocolVersion: number
}

const seconds = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : Number(value) * 1000

const millis = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : Number(value)

export function loadConfig(env: Record<string, string | undefined> = process.env): NodeConfig {
  const stateDir = env.AGENTICFORM_STATE_DIR ?? join(env.HOME ?? ".", ".agenticform-node")
  const config: NodeConfig = {
    hubUrl: env.AGENTICFORM_HUB_URL ?? "",
    stateDir,
    heartbeatIntervalMs: seconds(env.AGENTICFORM_HEARTBEAT_SECONDS, 15_000),
    pollMs: millis(env.AGENTICFORM_POLL_MS, 1_500),
    leaseRenewMs: seconds(env.AGENTICFORM_LEASE_RENEW_SECONDS, 300_000),
    requestTimeoutMs: seconds(env.AGENTICFORM_REQUEST_TIMEOUT_SECONDS, 30_000),
    harnessProbeTtlMs: seconds(env.AGENTICFORM_HARNESS_PROBE_TTL_SECONDS, 300_000),
    harnessProbeTimeoutMs: seconds(env.AGENTICFORM_HARNESS_PROBE_TIMEOUT_SECONDS, 20_000),
    protocolVersion: 1,
  }
  validateConfig(config)
  return config
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/**
 * The node dials out only, so a non-local hub must be HTTPS (FR-002, N1.1).
 * Startup refuses rather than degrading to plain HTTP.
 */
export function validateConfig(config: NodeConfig): void {
  const numbers: [string, number][] = [
    ["AGENTICFORM_HEARTBEAT_SECONDS", config.heartbeatIntervalMs],
    ["AGENTICFORM_POLL_MS", config.pollMs],
    ["AGENTICFORM_LEASE_RENEW_SECONDS", config.leaseRenewMs],
    ["AGENTICFORM_REQUEST_TIMEOUT_SECONDS", config.requestTimeoutMs],
    ["AGENTICFORM_HARNESS_PROBE_TTL_SECONDS", config.harnessProbeTtlMs],
    ["AGENTICFORM_HARNESS_PROBE_TIMEOUT_SECONDS", config.harnessProbeTimeoutMs],
  ]
  for (const [name, value] of numbers) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  }
  if (!Number.isInteger(config.protocolVersion) || config.protocolVersion < 1) {
    throw new Error("protocolVersion must be a positive integer")
  }
  if (!config.hubUrl) throw new Error("AGENTICFORM_HUB_URL is required")
  let url: URL
  try {
    url = new URL(config.hubUrl)
  } catch {
    throw new Error("AGENTICFORM_HUB_URL must be an absolute URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AGENTICFORM_HUB_URL must use http or https")
  }
  if (url.username || url.password) throw new Error("AGENTICFORM_HUB_URL must not carry credentials")
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("AGENTICFORM_HUB_URL must be a clean origin")
  }
  if (url.search || url.hash) throw new Error("AGENTICFORM_HUB_URL must be a clean origin")
  if (!LOOPBACK.has(url.hostname) && url.protocol !== "https:") {
    throw new Error("AGENTICFORM_HUB_URL must use HTTPS for a non-local host")
  }
}
