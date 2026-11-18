import { join } from "node:path"
import {
  NODE_CAPABILITIES_MAX_COUNT,
  NODE_HARNESSES_MAX_COUNT,
  NODE_LABEL_MAX_LENGTH,
  NODE_LABELS_MAX_COUNT,
  NODE_NAME_MAX_LENGTH,
  NODE_STRING_MAX_LENGTH,
} from "@agenticform/protocol"

export interface NodeConfig {
  hubUrl: string
  stateDir: string
  heartbeatIntervalMs: number
  pollMs: number
  leaseRenewMs: number
  requestTimeoutMs: number
  harnessProbeTtlMs: number
  harnessProbeReadyTtlMs: number
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
    harnessProbeReadyTtlMs: seconds(env.AGENTICFORM_HARNESS_PROBE_READY_TTL_SECONDS, 3_600_000),
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
    ["AGENTICFORM_HARNESS_PROBE_READY_TTL_SECONDS", config.harnessProbeReadyTtlMs],
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

const preview = (value: string): string => (value.length > 32 ? `${value.slice(0, 32)}…` : value)

/**
 * T-34: the hub refuses an over-limit advertisement with `400 invalid_input`,
 * which would leave the node silently offline. Refuse it here instead, before
 * the first network call, naming the env var and the limit.
 */
export function validateAdvertisements(input: {
  harnesses?: string[]
  capabilities?: string[]
  catalog?: string[]
}): void {
  const check = (name: string, values: string[] | undefined, maxCount: number): void => {
    if (values === undefined) return
    if (values.length > maxCount) throw new Error(`${name} must list at most ${maxCount} entries`)
    for (const value of values) {
      if (value.length > NODE_STRING_MAX_LENGTH) {
        throw new Error(`${name} entry "${preview(value)}" exceeds ${NODE_STRING_MAX_LENGTH} characters`)
      }
    }
  }
  check("AGENTICFORM_NODE_HARNESSES", input.harnesses, NODE_HARNESSES_MAX_COUNT)
  check("AGENTICFORM_NODE_CAPABILITIES", input.capabilities, NODE_CAPABILITIES_MAX_COUNT)
  check("runtime catalog harnesses", input.catalog, NODE_HARNESSES_MAX_COUNT)
}

/** T-34: the enrollment name and labels are stored, so bound them too. */
export function validateEnrollment(name: string, labels?: Record<string, string>): void {
  if (name.length > NODE_NAME_MAX_LENGTH) {
    throw new Error(`AGENTICFORM_NODE_NAME exceeds ${NODE_NAME_MAX_LENGTH} characters`)
  }
  if (labels === undefined) return
  const entries = Object.entries(labels)
  if (entries.length > NODE_LABELS_MAX_COUNT) {
    throw new Error(`labels must have at most ${NODE_LABELS_MAX_COUNT} entries`)
  }
  for (const [key, value] of entries) {
    if (key.length > NODE_LABEL_MAX_LENGTH) {
      throw new Error(`label key "${preview(key)}" exceeds ${NODE_LABEL_MAX_LENGTH} characters`)
    }
    if (value.length > NODE_LABEL_MAX_LENGTH) {
      throw new Error(`label "${preview(key)}" value exceeds ${NODE_LABEL_MAX_LENGTH} characters`)
    }
  }
}
