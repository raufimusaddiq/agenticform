import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  NODE_CAPABILITIES_MAX_COUNT,
  NODE_HARNESSES_MAX_COUNT,
  NODE_NAME_MAX_LENGTH,
  NODE_STRING_MAX_LENGTH,
} from "./index.ts"

export interface HubConfigFileSection {
  port?: number
  publicUrl?: string
  stateDir?: string
  dbPath?: string
  maxDepth?: number
  workflowTimeoutMs?: number
  workflowMaxChildRuns?: number
}

export interface NodeConfigFileSection {
  name?: string
  stateDir?: string
  slots?: number
  harnesses?: string[]
  capabilities?: string[]
}

export interface AgenticformConfigFile {
  hubUrl?: string
  token?: string
  adminToken?: string
  hub?: HubConfigFileSection
  node?: NodeConfigFileSection
}

export const CONFIG_KEYS = [
  "hubUrl",
  "token",
  "adminToken",
  "hub.port",
  "hub.publicUrl",
  "hub.stateDir",
  "hub.dbPath",
  "hub.maxDepth",
  "hub.workflowTimeoutMs",
  "hub.workflowMaxChildRuns",
  "node.name",
  "node.stateDir",
  "node.slots",
  "node.harnesses",
  "node.capabilities",
] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set(["token", "adminToken"])

const TOP_LEVEL_KEYS = new Set(["hubUrl", "token", "adminToken", "hub", "node"])
const HUB_KEYS = new Set([
  "port",
  "publicUrl",
  "stateDir",
  "dbPath",
  "maxDepth",
  "workflowTimeoutMs",
  "workflowMaxChildRuns",
])
const NODE_KEYS = new Set(["name", "stateDir", "slots", "harnesses", "capabilities"])
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

export function resolveConfigPath(env: Record<string, string | undefined> = process.env): string | null {
  if (env.AGENTICFORM_CONFIG) return env.AGENTICFORM_CONFIG
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "agenticform", "config.json")
  if (env.HOME) return join(env.HOME, ".config", "agenticform", "config.json")
  if (env === process.env && env.USERPROFILE) {
    return join(env.USERPROFILE, ".config", "agenticform", "config.json")
  }
  return null
}

export function defaultConfigPath(env: Record<string, string | undefined> = process.env): string {
  return resolveConfigPath(env) ?? join(homedir(), ".config", "agenticform", "config.json")
}

export function validateOriginUrl(raw: string, label: string): string {
  if (!raw) throw new Error(`${label} must be a non-empty URL`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`)
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not carry credentials`)
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${label} must be a clean origin`)
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must be a clean origin`)
  }
  if (!LOOPBACK.has(url.hostname) && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS for a non-local host`)
  }
  return url.origin
}

function asPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function asIntRange(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      max === Number.MAX_SAFE_INTEGER
        ? `${label} must be an integer >= ${min}`
        : `${label} must be an integer between ${min} and ${max}`,
    )
  }
  return value
}

function asStringList(value: unknown, label: string, maxCount: number): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
  if (value.length > maxCount) {
    throw new Error(`${label} must list at most ${maxCount} entries`)
  }
  for (const item of value) {
    if (item.length > NODE_STRING_MAX_LENGTH) {
      throw new Error(`${label} entry exceeds ${NODE_STRING_MAX_LENGTH} characters`)
    }
  }
  return [...value]
}

export function validateConfigFile(value: unknown, source = "config"): AgenticformConfigFile {
  const root = asPlainObject(value, source)
  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`${source}: unknown key "${key}"`)
  }
  const out: AgenticformConfigFile = {}

  if (root.hubUrl !== undefined) {
    out.hubUrl = validateOriginUrl(asNonEmptyString(root.hubUrl, `${source}.hubUrl`), `${source}.hubUrl`)
  }
  if (root.token !== undefined) {
    const token = asNonEmptyString(root.token, `${source}.token`)
    if (/[\r\n]/.test(token)) throw new Error(`${source}.token must not contain newlines`)
    out.token = token
  }
  if (root.adminToken !== undefined) {
    const adminToken = asNonEmptyString(root.adminToken, `${source}.adminToken`)
    if (/[\r\n]/.test(adminToken)) throw new Error(`${source}.adminToken must not contain newlines`)
    if (adminToken.length < 32) {
      throw new Error(`${source}.adminToken must be at least 32 characters`)
    }
    out.adminToken = adminToken
  }
  if (root.hub !== undefined) {
    const rawHub = asPlainObject(root.hub, `${source}.hub`)
    for (const key of Object.keys(rawHub)) {
      if (!HUB_KEYS.has(key)) throw new Error(`${source}.hub: unknown key "${key}"`)
    }
    const hub: HubConfigFileSection = {}
    if (rawHub.port !== undefined) hub.port = asIntRange(rawHub.port, `${source}.hub.port`, 0, 65_535)
    if (rawHub.publicUrl !== undefined) {
      hub.publicUrl = validateOriginUrl(
        asNonEmptyString(rawHub.publicUrl, `${source}.hub.publicUrl`),
        `${source}.hub.publicUrl`,
      )
    }
    if (rawHub.stateDir !== undefined) {
      hub.stateDir = asNonEmptyString(rawHub.stateDir, `${source}.hub.stateDir`)
    }
    if (rawHub.dbPath !== undefined) {
      hub.dbPath = asNonEmptyString(rawHub.dbPath, `${source}.hub.dbPath`)
    }
    if (rawHub.maxDepth !== undefined) {
      hub.maxDepth = asIntRange(rawHub.maxDepth, `${source}.hub.maxDepth`, 0)
    }
    if (rawHub.workflowTimeoutMs !== undefined) {
      hub.workflowTimeoutMs = asIntRange(rawHub.workflowTimeoutMs, `${source}.hub.workflowTimeoutMs`, 1)
    }
    if (rawHub.workflowMaxChildRuns !== undefined) {
      hub.workflowMaxChildRuns = asIntRange(
        rawHub.workflowMaxChildRuns,
        `${source}.hub.workflowMaxChildRuns`,
        0,
      )
    }
    if (Object.keys(hub).length > 0) out.hub = hub
  }
  if (root.node !== undefined) {
    const rawNode = asPlainObject(root.node, `${source}.node`)
    for (const key of Object.keys(rawNode)) {
      if (!NODE_KEYS.has(key)) throw new Error(`${source}.node: unknown key "${key}"`)
    }
    const node: NodeConfigFileSection = {}
    if (rawNode.name !== undefined) {
      const name = asNonEmptyString(rawNode.name, `${source}.node.name`)
      if (name.length > NODE_NAME_MAX_LENGTH) {
        throw new Error(`${source}.node.name exceeds ${NODE_NAME_MAX_LENGTH} characters`)
      }
      node.name = name
    }
    if (rawNode.stateDir !== undefined) {
      node.stateDir = asNonEmptyString(rawNode.stateDir, `${source}.node.stateDir`)
    }
    if (rawNode.slots !== undefined) {
      node.slots = asIntRange(rawNode.slots, `${source}.node.slots`, 1)
    }
    if (rawNode.harnesses !== undefined) {
      node.harnesses = asStringList(
        rawNode.harnesses,
        `${source}.node.harnesses`,
        NODE_HARNESSES_MAX_COUNT,
      )
    }
    if (rawNode.capabilities !== undefined) {
      node.capabilities = asStringList(
        rawNode.capabilities,
        `${source}.node.capabilities`,
        NODE_CAPABILITIES_MAX_COUNT,
      )
    }
    if (Object.keys(node).length > 0) out.node = node
  }
  return out
}

export function loadConfigFile(
  env: Record<string, string | undefined> = process.env,
): AgenticformConfigFile {
  const path = resolveConfigPath(env)
  if (!path) return {}
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "ENOENT") return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${path}: invalid JSON`)
  }
  return validateConfigFile(parsed, path)
}

export function saveConfigFile(config: AgenticformConfigFile, path: string): void {
  const validated = validateConfigFile(config, path)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function assertConfigKey(key: string): ConfigKey {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown config key "${key}". Supported keys: ${CONFIG_KEYS.join(", ")}`)
  }
  return key as ConfigKey
}

function parseIntString(raw: string, key: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} must be a safe integer`)
  return parsed
}

function parseListString(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function setConfigValue(
  config: AgenticformConfigFile,
  key: string,
  rawValue: string,
): AgenticformConfigFile {
  const checkedKey = assertConfigKey(key)
  const next: AgenticformConfigFile = structuredClone(config)
  switch (checkedKey) {
    case "hubUrl":
      next.hubUrl = rawValue
      break
    case "token":
      next.token = rawValue
      break
    case "adminToken":
      next.adminToken = rawValue
      break
    case "hub.port":
      next.hub = { ...next.hub, port: parseIntString(rawValue, checkedKey) }
      break
    case "hub.publicUrl":
      next.hub = { ...next.hub, publicUrl: rawValue }
      break
    case "hub.stateDir":
      next.hub = { ...next.hub, stateDir: rawValue }
      break
    case "hub.dbPath":
      next.hub = { ...next.hub, dbPath: rawValue }
      break
    case "hub.maxDepth":
      next.hub = { ...next.hub, maxDepth: parseIntString(rawValue, checkedKey) }
      break
    case "hub.workflowTimeoutMs":
      next.hub = { ...next.hub, workflowTimeoutMs: parseIntString(rawValue, checkedKey) }
      break
    case "hub.workflowMaxChildRuns":
      next.hub = { ...next.hub, workflowMaxChildRuns: parseIntString(rawValue, checkedKey) }
      break
    case "node.name":
      next.node = { ...next.node, name: rawValue }
      break
    case "node.stateDir":
      next.node = { ...next.node, stateDir: rawValue }
      break
    case "node.slots":
      next.node = { ...next.node, slots: parseIntString(rawValue, checkedKey) }
      break
    case "node.harnesses":
      next.node = { ...next.node, harnesses: parseListString(rawValue) }
      break
    case "node.capabilities":
      next.node = { ...next.node, capabilities: parseListString(rawValue) }
      break
  }
  return validateConfigFile(next, "config")
}

export function unsetConfigValue(
  config: AgenticformConfigFile,
  key: string,
): AgenticformConfigFile {
  const checkedKey = assertConfigKey(key)
  const next: AgenticformConfigFile = structuredClone(config)
  switch (checkedKey) {
    case "hubUrl":
      delete next.hubUrl
      break
    case "token":
      delete next.token
      break
    case "adminToken":
      delete next.adminToken
      break
    case "hub.port":
      if (next.hub) delete next.hub.port
      break
    case "hub.publicUrl":
      if (next.hub) delete next.hub.publicUrl
      break
    case "hub.stateDir":
      if (next.hub) delete next.hub.stateDir
      break
    case "hub.dbPath":
      if (next.hub) delete next.hub.dbPath
      break
    case "hub.maxDepth":
      if (next.hub) delete next.hub.maxDepth
      break
    case "hub.workflowTimeoutMs":
      if (next.hub) delete next.hub.workflowTimeoutMs
      break
    case "hub.workflowMaxChildRuns":
      if (next.hub) delete next.hub.workflowMaxChildRuns
      break
    case "node.name":
      if (next.node) delete next.node.name
      break
    case "node.stateDir":
      if (next.node) delete next.node.stateDir
      break
    case "node.slots":
      if (next.node) delete next.node.slots
      break
    case "node.harnesses":
      if (next.node) delete next.node.harnesses
      break
    case "node.capabilities":
      if (next.node) delete next.node.capabilities
      break
  }
  if (next.hub && Object.keys(next.hub).length === 0) delete next.hub
  if (next.node && Object.keys(next.node).length === 0) delete next.node
  return validateConfigFile(next, "config")
}

export type ConfigValueSource = "env" | "file" | "default"

export interface RedactedConfigEntry {
  value: string | number | string[] | null
  source: ConfigValueSource
}

export interface RedactedConfigView {
  configPath: string
  exists: boolean
  values: Record<ConfigKey, RedactedConfigEntry>
}

function entry(
  envValue: string | undefined,
  fileValue: string | number | string[] | undefined,
  defaultValue: string | number | string[] | null,
  parseEnv: (raw: string) => string | number | string[] = (raw) => raw,
  secret = false,
): RedactedConfigEntry {
  if (envValue !== undefined && envValue !== "") {
    return { value: secret ? "***" : parseEnv(envValue), source: "env" }
  }
  if (fileValue !== undefined) {
    return { value: secret ? "***" : fileValue, source: "file" }
  }
  return { value: defaultValue, source: "default" }
}

export function redactedConfigView(
  env: Record<string, string | undefined> = process.env,
): RedactedConfigView {
  const resolved = resolveConfigPath(env)
  const configPath = resolved ?? defaultConfigPath(env)
  const exists = resolved !== null && existsSync(resolved)
  const file = loadConfigFile(env)
  return {
    configPath,
    exists,
    values: {
      hubUrl: entry(env.AGENTICFORM_HUB_URL, file.hubUrl, null),
      token: entry(env.AGENTICFORM_TOKEN, file.token, null, (v) => v, true),
      adminToken: entry(env.AGENTICFORM_ADMIN_TOKEN, file.adminToken, null, (v) => v, true),
      "hub.port": entry(env.AGENTICFORM_HUB_PORT, file.hub?.port, 8787, (v) => Number(v)),
      "hub.publicUrl": entry(env.AGENTICFORM_HUB_URL, file.hub?.publicUrl, null),
      "hub.stateDir": entry(env.AGENTICFORM_STATE_DIR, file.hub?.stateDir, null),
      "hub.dbPath": entry(env.AGENTICFORM_HUB_DB, file.hub?.dbPath, null),
      "hub.maxDepth": entry(env.AGENTICFORM_RUN_MAX_DEPTH, file.hub?.maxDepth, 3, (v) => Number(v)),
      "hub.workflowTimeoutMs": entry(
        env.AGENTICFORM_WORKFLOW_TIMEOUT_MS,
        file.hub?.workflowTimeoutMs,
        30_000,
        (v) => Number(v),
      ),
      "hub.workflowMaxChildRuns": entry(
        env.AGENTICFORM_WORKFLOW_MAX_CHILD_RUNS,
        file.hub?.workflowMaxChildRuns,
        20,
        (v) => Number(v),
      ),
      "node.name": entry(env.AGENTICFORM_NODE_NAME, file.node?.name, null),
      "node.stateDir": entry(env.AGENTICFORM_STATE_DIR, file.node?.stateDir, null),
      "node.slots": entry(env.AGENTICFORM_NODE_SLOTS, file.node?.slots, 1, (v) => Number(v)),
      "node.harnesses": entry(env.AGENTICFORM_NODE_HARNESSES, file.node?.harnesses, [], parseListString),
      "node.capabilities": entry(
        env.AGENTICFORM_NODE_CAPABILITIES,
        file.node?.capabilities,
        [],
        parseListString,
      ),
    },
  }
}
