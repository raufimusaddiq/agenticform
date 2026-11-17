#!/usr/bin/env bun
import { hostname } from "node:os"
import type { EnrollRequest, EnrollResponse } from "@agenticform/protocol"
import { loadConfig, type NodeConfig } from "../src/config.ts"
import { generateKeyPair, loadIdentity, saveIdentity } from "../src/identity.ts"

export interface EnrollOptions {
  token: string
  name: string
  harnesses: string[]
  labels?: Record<string, string>
}

/**
 * One outbound call (FR-001). The token is sent once and never stored; the
 * private key stays local and the identity is persisted at mode 0600 (FR-012).
 */
export async function enroll(
  config: NodeConfig,
  options: EnrollOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<EnrollResponse> {
  const existing = loadIdentity(config.stateDir)
  const keys = existing ?? generateKeyPair()
  const body: EnrollRequest = {
    token: options.token,
    name: options.name,
    publicKey: keys.publicKeyB64,
    protocolVersion: config.protocolVersion,
    harnesses: options.harnesses,
    ...(options.labels ? { labels: options.labels } : {}),
  }
  const response = await fetchImpl(`${config.hubUrl}/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  })
  if (!response.ok) throw new Error(`enrollment failed with ${response.status}`)
  const enrolled = (await response.json()) as EnrollResponse
  saveIdentity(config.stateDir, {
    nodeId: enrolled.nodeId,
    publicKeyB64: keys.publicKeyB64,
    privateKeyPem: keys.privateKeyPem,
    hubUrl: config.hubUrl,
  })
  return enrolled
}

if (import.meta.main) {
  const [command] = process.argv.slice(2)
  if (command !== "enroll") {
    console.error("usage: agenticform-node enroll")
    process.exit(1)
  }
  const token = process.env.AGENTICFORM_ENROLL_TOKEN
  if (!token) {
    console.error("AGENTICFORM_ENROLL_TOKEN is required")
    process.exit(1)
  }
  const harnesses = (process.env.AGENTICFORM_NODE_HARNESSES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const enrolled = await enroll(loadConfig(), {
    token,
    name: process.env.AGENTICFORM_NODE_NAME ?? hostname(),
    harnesses,
  })
  console.log(`enrolled node ${enrolled.nodeId}`)
}
