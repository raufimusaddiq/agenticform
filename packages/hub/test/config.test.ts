import { describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createHub, openDatabase } from "../src/index.ts"
import { loadConfig, validateConfig, type HubConfig } from "../src/config.ts"
import { api, startHub, testConfig } from "./helpers.ts"

const base = (patch: Partial<HubConfig>): HubConfig => ({ ...testConfig(), port: 8787, ...patch })

describe("hub config", () => {
  test("a missing or short admin token refuses to start", () => {
    expect(() => validateConfig(base({ adminToken: "" }))).toThrow()
    expect(() => validateConfig(base({ adminToken: "short" }))).toThrow()
    expect(() => validateConfig(base({ adminToken: "x".repeat(32) }))).not.toThrow()
  })

  test("a non-local plain-HTTP public URL refuses to start", () => {
    expect(() => validateConfig(base({ publicUrl: "http://example.com" }))).toThrow()
    expect(() => validateConfig(base({ publicUrl: "https://example.com" }))).not.toThrow()
    expect(() => validateConfig(base({ publicUrl: "http://127.0.0.1:8787" }))).not.toThrow()
  })

  test("the public URL must be a clean origin", () => {
    expect(() => validateConfig(base({ publicUrl: "https://example.com/path" }))).toThrow()
    expect(() => validateConfig(base({ publicUrl: "https://user:pass@example.com" }))).toThrow()
    expect(() => validateConfig(base({ publicUrl: "https://example.com?x=1" }))).toThrow()
    expect(() => validateConfig(base({ publicUrl: "https://example.com#x" }))).toThrow()
  })

  test("numeric settings must be finite and positive", () => {    expect(() => loadConfig({ AGENTICFORM_ADMIN_TOKEN: "y".repeat(32), AGENTICFORM_CLOCK_SKEW_SECONDS: "abc" })).toThrow()
    expect(() => loadConfig({ AGENTICFORM_ADMIN_TOKEN: "y".repeat(32), AGENTICFORM_NONCE_TTL_SECONDS: "0" })).toThrow()
    expect(() => loadConfig({ AGENTICFORM_ADMIN_TOKEN: "y".repeat(32), AGENTICFORM_LEASE_SECONDS: "-1" })).toThrow()
    expect(() => loadConfig({ AGENTICFORM_ADMIN_TOKEN: "y".repeat(32), AGENTICFORM_POLL_MS: "NaN" })).toThrow()
    expect(() => loadConfig({ AGENTICFORM_ADMIN_TOKEN: "y".repeat(32), AGENTICFORM_HUB_PORT: "abc" })).toThrow()
    expect(() => loadConfig({ AGENTICFORM_ADMIN_TOKEN: "y".repeat(32), AGENTICFORM_HUB_PORT: "70000" })).toThrow()
    expect(() => validateConfig(base({ clockSkewMs: Number.NaN }))).toThrow()
    expect(() => validateConfig(base({ leaseMs: 0 }))).toThrow()
  })

  test("the nonce TTL must outlive the clock-skew replay window", () => {
    expect(() => validateConfig(base({ clockSkewMs: 120_000, nonceTtlMs: 300_000 }))).not.toThrow()
    expect(() => validateConfig(base({ clockSkewMs: 120_000, nonceTtlMs: 299_999 }))).toThrow()
    expect(() => loadConfig({ AGENTICFORM_ADMIN_TOKEN: "y".repeat(32), AGENTICFORM_CLOCK_SKEW_SECONDS: "120", AGENTICFORM_NONCE_TTL_SECONDS: "299" })).toThrow()
  })

  test("the offline window must exceed the heartbeat interval", () => {
    expect(() => validateConfig(base({ heartbeatIntervalMs: 15_000, nodeOfflineMs: 15_001 }))).not.toThrow()
    expect(() => validateConfig(base({ heartbeatIntervalMs: 15_000, nodeOfflineMs: 15_000 }))).toThrow()
  })

  test("the state directory uses the HOME from the provided env", () => {
    const config = loadConfig({
      AGENTICFORM_ADMIN_TOKEN: "y".repeat(32),
      HOME: "/tmp/af-custom-home",
    })
    expect(config.stateFile).toBe("/tmp/af-custom-home/.agenticform-hub/hub.sqlite")
  })

  test("loadConfig reads the documented environment variables", () => {    const config = loadConfig({
      AGENTICFORM_ADMIN_TOKEN: "y".repeat(32),
      AGENTICFORM_HUB_URL: "https://hub.example.com",
      AGENTICFORM_STATE_DIR: "/tmp/af-state",
      AGENTICFORM_HEARTBEAT_SECONDS: "5",
      AGENTICFORM_NODE_OFFLINE_SECONDS: "20",
      AGENTICFORM_LEASE_SECONDS: "60",
    })
    expect(config.stateFile).toBe("/tmp/af-state/hub.sqlite")
    expect(config.heartbeatIntervalMs).toBe(5_000)
    expect(config.nodeOfflineMs).toBe(20_000)
    expect(config.leaseMs).toBe(60_000)
  })

  test("a state directory is created with mode 0700", () => {
    const root = mkdtempSync(join(tmpdir(), "af-db-"))
    const file = join(root, "nested", "state", "hub.sqlite")
    const db = openDatabase(file)
    db.close()
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
  })

  test("createHub refuses to construct without a valid config", () => {    expect(() => createHub(testConfig({ adminToken: "" }))).toThrow()
    expect(() => createHub(testConfig({ adminToken: "short" }))).toThrow()
    expect(() => createHub(testConfig({ clockSkewMs: Number.NaN }))).toThrow()
    expect(() => createHub(testConfig({ publicUrl: "http://example.com" }))).toThrow()
  })

  test("an empty bearer never authenticates", async () => {
    const hub = startHub()
    try {
      const missing = await fetch(`${hub.url}/v1/nodes`)
      expect(missing.status).toBe(401)
      const empty = await api(hub, "GET", "/v1/nodes", undefined, "")
      expect(empty.status).toBe(401)
      const wrong = await api(hub, "GET", "/v1/nodes", undefined, "x".repeat(32))
      expect(wrong.status).toBe(401)
    } finally {
      hub.stop()
    }
  })
})
