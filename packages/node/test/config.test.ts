import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadConfig, validateConfig, type NodeConfig } from "../src/config.ts"

const base = (patch: Partial<NodeConfig>): NodeConfig => ({
  hubUrl: "https://hub.example.com",
  stateDir: "/tmp/af-node",
  heartbeatIntervalMs: 15_000,
  pollMs: 1_500,
  leaseRenewMs: 300_000,
  requestTimeoutMs: 30_000,
  harnessProbeTtlMs: 300_000,
  harnessProbeTimeoutMs: 20_000,
  protocolVersion: 1,
  ...patch,
})

describe("node config", () => {
  test("a non-local plain-HTTP hub URL refuses to start", () => {
    expect(() => validateConfig(base({ hubUrl: "http://example.com" }))).toThrow()
    expect(() => validateConfig(base({ hubUrl: "http://192.168.1.10:8787" }))).toThrow()
    expect(() => validateConfig(base({ hubUrl: "https://example.com" }))).not.toThrow()
    expect(() => validateConfig(base({ hubUrl: "http://127.0.0.1:8787" }))).not.toThrow()
    expect(() => validateConfig(base({ hubUrl: "http://localhost:8787" }))).not.toThrow()
    expect(() => validateConfig(base({ hubUrl: "http://[::1]:8787" }))).not.toThrow()
  })

  test("a missing or malformed hub URL refuses to start", () => {
    expect(() => validateConfig(base({ hubUrl: "" }))).toThrow()
    expect(() => validateConfig(base({ hubUrl: "hub.example.com" }))).toThrow()
    expect(() => validateConfig(base({ hubUrl: "ftp://example.com" }))).toThrow()
  })

  test("the hub URL must be a clean origin", () => {
    expect(() => validateConfig(base({ hubUrl: "https://example.com/path" }))).toThrow()
    expect(() => validateConfig(base({ hubUrl: "https://user:pass@example.com" }))).toThrow()
    expect(() => validateConfig(base({ hubUrl: "https://example.com?x=1" }))).toThrow()
    expect(() => validateConfig(base({ hubUrl: "https://example.com#x" }))).toThrow()
  })

  test("numeric settings must be finite and positive", () => {
    expect(() =>
      loadConfig({ AGENTICFORM_HUB_URL: "https://hub.example.com", AGENTICFORM_POLL_MS: "abc" }),
    ).toThrow()
    expect(() =>
      loadConfig({ AGENTICFORM_HUB_URL: "https://hub.example.com", AGENTICFORM_HEARTBEAT_SECONDS: "0" }),
    ).toThrow()
    expect(() =>
      loadConfig({ AGENTICFORM_HUB_URL: "https://hub.example.com", AGENTICFORM_LEASE_RENEW_SECONDS: "-1" }),
    ).toThrow()
    expect(() => loadConfig({})).toThrow(/AGENTICFORM_HUB_URL/)
    expect(() => loadConfig({ AGENTICFORM_HUB_URL: "http://example.com" })).toThrow()
  })

  test("the harness probe settings default and validate", () => {
    const config = loadConfig({ AGENTICFORM_HUB_URL: "https://hub.example.com" })
    expect(config.harnessProbeTtlMs).toBe(300_000)
    expect(config.harnessProbeTimeoutMs).toBe(20_000)
    expect(() =>
      loadConfig({ AGENTICFORM_HUB_URL: "https://hub.example.com", AGENTICFORM_HARNESS_PROBE_TTL_SECONDS: "0" }),
    ).toThrow()
    expect(() =>
      loadConfig({ AGENTICFORM_HUB_URL: "https://hub.example.com", AGENTICFORM_HARNESS_PROBE_TIMEOUT_SECONDS: "abc" }),
    ).toThrow()
  })

  test("the state directory defaults to HOME and can be overridden", () => {
    const fallback = loadConfig({ AGENTICFORM_HUB_URL: "https://hub.example.com", HOME: "/tmp/af-home" })
    expect(fallback.stateDir).toBe(join("/tmp/af-home", ".agenticform-node"))
    const override = loadConfig({
      AGENTICFORM_HUB_URL: "https://hub.example.com",
      AGENTICFORM_STATE_DIR: "/tmp/af-state",
      AGENTICFORM_POLL_MS: "250",
    })
    expect(override.stateDir).toBe("/tmp/af-state")
    expect(override.pollMs).toBe(250)
  })
})
