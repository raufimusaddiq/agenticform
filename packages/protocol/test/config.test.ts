import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadConfigFile,
  redactedConfigView,
  resolveConfigPath,
  saveConfigFile,
  setConfigValue,
  unsetConfigValue,
  validateConfigFile,
} from "../src/config.ts"

describe("shared config file", () => {
  test("resolveConfigPath respects AGENTICFORM_CONFIG, XDG_CONFIG_HOME, HOME, and returns null for empty synthetic env", () => {
    expect(resolveConfigPath({})).toBeNull()
    expect(resolveConfigPath({ HOME: "/tmp/h" })).toBe(join("/tmp/h", ".config", "agenticform", "config.json"))
    expect(resolveConfigPath({ HOME: "/tmp/h", XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      join("/tmp/xdg", "agenticform", "config.json"),
    )
    expect(
      resolveConfigPath({
        HOME: "/tmp/h",
        XDG_CONFIG_HOME: "/tmp/xdg",
        AGENTICFORM_CONFIG: "/tmp/custom.json",
      }),
    ).toBe("/tmp/custom.json")
  })

  test("saveConfigFile and loadConfigFile round-trip and fail closed on corrupt JSON or unknown keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-cfg-"))
    try {
      const file = join(dir, "nested", "config.json")
      saveConfigFile(
        {
          hubUrl: "https://hub.example.com",
          token: "afc_123_secret",
          adminToken: "x".repeat(32),
          hub: { port: 9000, maxDepth: 4 },
          node: { name: "box-1", slots: 2, harnesses: ["codex"] },
        },
        file,
      )
      const loaded = loadConfigFile({ AGENTICFORM_CONFIG: file })
      expect(loaded).toEqual({
        hubUrl: "https://hub.example.com",
        token: "afc_123_secret",
        adminToken: "x".repeat(32),
        hub: { port: 9000, maxDepth: 4 },
        node: { name: "box-1", slots: 2, harnesses: ["codex"] },
      })

      const corrupt = join(dir, "corrupt.json")
      writeFileSync(corrupt, "{not json")
      expect(() => loadConfigFile({ AGENTICFORM_CONFIG: corrupt })).toThrow(/invalid JSON/)

      expect(() => validateConfigFile({ unknown: 1 })).toThrow(/unknown key/)
      expect(() => validateConfigFile({ adminToken: "short" })).toThrow(/at least 32 characters/)
      expect(() => validateConfigFile({ hubUrl: "http://example.com" })).toThrow(/HTTPS/)
      expect(() => validateConfigFile({ hub: { port: 70000 } })).toThrow(/between 0 and 65535/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("setConfigValue, unsetConfigValue, and redactedConfigView enforce validation and redact secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-cfg-view-"))
    try {
      const file = join(dir, "config.json")
      let cfg = setConfigValue({}, "hubUrl", "http://127.0.0.1:8787")
      cfg = setConfigValue(cfg, "token", "afc_secret_value")
      cfg = setConfigValue(cfg, "adminToken", "a".repeat(32))
      cfg = setConfigValue(cfg, "node.harnesses", "codex, claude")
      cfg = setConfigValue(cfg, "hub.port", "8788")
      saveConfigFile(cfg, file)

      const view = redactedConfigView({
        AGENTICFORM_CONFIG: file,
        AGENTICFORM_HUB_PORT: "9999",
      })
      expect(view.exists).toBe(true)
      expect(view.values.hubUrl).toEqual({ value: "http://127.0.0.1:8787", source: "file" })
      expect(view.values.token).toEqual({ value: "***", source: "file" })
      expect(view.values.adminToken).toEqual({ value: "***", source: "file" })
      expect(view.values["hub.port"]).toEqual({ value: 9999, source: "env" })
      expect(view.values["node.harnesses"]).toEqual({ value: ["codex", "claude"], source: "file" })
      expect(JSON.stringify(view)).not.toContain("afc_secret_value")
      expect(JSON.stringify(view)).not.toContain("a".repeat(32))

      const cleaned = unsetConfigValue(cfg, "hub.port")
      expect(cleaned.hub).toBeUndefined()
      expect(() => setConfigValue({}, "bogus", "1")).toThrow(/unknown config key/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
