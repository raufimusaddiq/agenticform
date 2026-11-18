import { generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalString } from "@agenticform/protocol/canonical"
import type { HubConfig } from "../src/config.ts"
import { createHub, type Hub } from "../src/index.ts"

export function testConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    adminToken: "test-admin-token-0123456789abcdef",
    publicUrl: null,
    stateFile: join(mkdtempSync(join(tmpdir(), "af-hub-")), "hub.sqlite"),
    port: 0,
    clockSkewMs: 120_000,
    heartbeatIntervalMs: 15_000,
    nodeOfflineMs: 45_000,
    enrollmentTtlMs: 600_000,
    nonceTtlMs: 600_000,
    nonceCleanupMs: 600_000,
    leaseMs: 900_000,
    pollMs: 1_500,
    recoveryGraceMs: 120_000,
    maxBodyBytes: 1_048_576,
    maxDepth: 3,
    ...overrides,
  }
}

export function startHub(overrides: Partial<HubConfig> = {}): Hub {
  return createHub(testConfig(overrides))
}

export interface ApiResult {
  status: number
  body: any
}

export async function api(
  hub: Hub,
  method: string,
  path: string,
  body?: unknown,
  token = hub.config.adminToken,
): Promise<ApiResult> {
  const response = await fetch(hub.url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

export interface TestNode {
  nodeId: string
  publicKeyB64: string
  privateKey: KeyObject
  token: string
}

export async function enroll(
  hub: Hub,
  options: {
    name?: string
    protocolVersion?: number
    harnesses?: string[]
    labels?: Record<string, string>
  } = {},
): Promise<TestNode> {
  const issued = await api(hub, "POST", "/v1/enrollment-tokens")
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64")
  const response = await api(hub, "POST", "/v1/enroll", {
    token: issued.body.token,
    name: options.name ?? "node-1",
    publicKey: publicKeyB64,
    protocolVersion: options.protocolVersion ?? 1,
    harnesses: options.harnesses ?? ["codex"],
    labels: options.labels ?? {},
  })
  if (response.status !== 201) throw new Error(`enroll failed: ${JSON.stringify(response.body)}`)
  return { nodeId: response.body.nodeId, publicKeyB64, privateKey, token: issued.body.token }
}

export interface SignOptions {
  nonce?: string
  timestamp?: number
  signature?: string
}

export function signedFetch(
  hub: Hub,
  node: TestNode,
  method: string,
  path: string,
  body?: unknown,
  options: SignOptions = {},
): Promise<Response> {
  const raw = body === undefined ? "" : JSON.stringify(body)
  const timestamp = options.timestamp ?? Date.now()
  const nonce = options.nonce ?? randomBytes(16).toString("hex")
  const canonical = canonicalString({
    nodeId: node.nodeId,
    timestampMs: timestamp,
    nonce,
    method,
    path,
    body: raw,
  })
  const signature =
    options.signature ?? cryptoSign(null, Buffer.from(canonical), node.privateKey).toString("base64")
  return fetch(hub.url + path, {
    method,
    headers: {
      "x-af-node-id": node.nodeId,
      "x-af-timestamp": String(timestamp),
      "x-af-nonce": nonce,
      "x-af-signature": signature,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: raw }),
  })
}

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } }
  return body.error.code
}

export async function heartbeat(
  hub: Hub,
  node: TestNode,
  body: Record<string, unknown> = {},
): Promise<ApiResult> {
  const response = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", {
    protocolVersion: 1,
    harnesses: ["codex"],
    capabilities: ["mcp.http", "git"],
    capacity: { slots: 1, inUse: 0 },
    runtimes: [],
    ...body,
  })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

export async function nextCommand(hub: Hub, node: TestNode): Promise<ApiResult> {
  const response = await signedFetch(hub, node, "GET", "/v1/node/commands/next")
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

export async function createRun(hub: Hub, body: Record<string, unknown> = {}): Promise<ApiResult> {
  return api(hub, "POST", "/v1/runs", {
    idempotencyKey: `key-${randomBytes(6).toString("hex")}`,
    harness: "codex",
    prompt: "fix failing tests",
    ...body,
  })
}
