import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveConfigFile } from "@agenticform/protocol/config"
import { loadConfig, validateAdvertisements, validateConfig, validateEnrollment, type NodeConfig } from "../src/config.ts"
import { generateKeyPair, saveIdentity } from "../src/identity.ts"

const base = (patch: Partial<NodeConfig>): NodeConfig => ({
  hubUrl: "https://hub.example.com",
  stateDir: "/tmp/af-node",
  heartbeatIntervalMs: 15_000,
  pollMs: 1_500,
  leaseRenewMs: 300_000,
  requestTimeoutMs: 30_000,
  harnessProbeTtlMs: 300_000,
  harnessProbeReadyTtlMs: 3_600_000,
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
    expect(config.harnessProbeReadyTtlMs).toBe(3_600_000)
    expect(config.harnessProbeTimeoutMs).toBe(20_000)
    expect(() =>
      loadConfig({ AGENTICFORM_HUB_URL: "https://hub.example.com", AGENTICFORM_HARNESS_PROBE_TTL_SECONDS: "0" }),
    ).toThrow()
    expect(() =>
      loadConfig({
        AGENTICFORM_HUB_URL: "https://hub.example.com",
        AGENTICFORM_HARNESS_PROBE_READY_TTL_SECONDS: "0",
      }),
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

describe("advertisement limits (T-34)", () => {
  const many = (n: number, prefix = "h"): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

  test("harnesses at the limit pass, one over fails naming the env var", () => {
    expect(() => validateAdvertisements({ harnesses: many(32) })).not.toThrow()
    expect(() => validateAdvertisements({ harnesses: many(33) })).toThrow(/AGENTICFORM_NODE_HARNESSES.*32/)
    expect(() => validateAdvertisements({ harnesses: ["x".repeat(64)] })).not.toThrow()
    expect(() => validateAdvertisements({ harnesses: ["x".repeat(65)] })).toThrow(/AGENTICFORM_NODE_HARNESSES.*64/)
  })

  test("capabilities at the limit pass, one over fails naming the env var", () => {
    expect(() => validateAdvertisements({ capabilities: many(32, "c") })).not.toThrow()
    expect(() => validateAdvertisements({ capabilities: many(33, "c") })).toThrow(/AGENTICFORM_NODE_CAPABILITIES.*32/)
    expect(() => validateAdvertisements({ capabilities: ["x".repeat(64)] })).not.toThrow()
    expect(() => validateAdvertisements({ capabilities: ["x".repeat(65)] })).toThrow(/AGENTICFORM_NODE_CAPABILITIES.*64/)
  })

  test("runtime catalog ids at the limit pass, one over fails", () => {
    expect(() => validateAdvertisements({ catalog: many(32) })).not.toThrow()
    expect(() => validateAdvertisements({ catalog: many(33) })).toThrow(/catalog.*32/)
    expect(() => validateAdvertisements({ catalog: ["x".repeat(64)] })).not.toThrow()
    expect(() => validateAdvertisements({ catalog: ["x".repeat(65)] })).toThrow(/catalog.*64/)
  })

  test("enrollment name and labels at the limit pass, one over fails", () => {
    expect(() => validateEnrollment("n".repeat(64))).not.toThrow()
    expect(() => validateEnrollment("n".repeat(65))).toThrow(/AGENTICFORM_NODE_NAME.*64/)
    const labels = Object.fromEntries(many(32, "k").map((key) => [key, "v"]))
    expect(() => validateEnrollment("n", labels)).not.toThrow()
    expect(() => validateEnrollment("n", { ...labels, extra: "v" })).toThrow(/labels.*32/)
    expect(() => validateEnrollment("n", { ["k".repeat(64)]: "v" })).not.toThrow()
    expect(() => validateEnrollment("n", { ["k".repeat(65)]: "v" })).toThrow(/label key.*64/)
    expect(() => validateEnrollment("n", { k: "v".repeat(64) })).not.toThrow()
    expect(() => validateEnrollment("n", { k: "v".repeat(65) })).toThrow(/label.*64/)
  })
})

describe("node config file and identity fallback", () => {
  test("reads AGENTICFORM_CONFIG and falls back to identity.json hubUrl", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-node-cfg-"))
    try {
      const stateDir = join(dir, "node-state")
      const cfgFile = join(dir, "config.json")
      saveConfigFile(
        {
          hubUrl: "https://cfg.example.com",
          node: { stateDir },
        },
        cfgFile,
      )
      const fromFile = loadConfig({ AGENTICFORM_CONFIG: cfgFile })
      expect(fromFile.hubUrl).toBe("https://cfg.example.com")
      expect(fromFile.stateDir).toBe(stateDir)

      const keys = generateKeyPair()
      saveIdentity(stateDir, {
        nodeId: "node-1",
        publicKeyB64: keys.publicKeyB64,
        privateKeyPem: keys.privateKeyPem,
        hubUrl: "https://identity.example.com",
      })
      const fromIdentity = loadConfig({ AGENTICFORM_STATE_DIR: stateDir, AGENTICFORM_HUB_URL: "" })
      expect(fromIdentity.hubUrl).toBe("https://identity.example.com")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
