#!/usr/bin/env bun
import { hostname } from "node:os"
import type { EnrollRequest, EnrollResponse } from "@agenticform/protocol"
import { loadConfigFile } from "@agenticform/protocol/config"
import { loadConfig, validateAdvertisements, validateEnrollment, type NodeConfig } from "../src/config.ts"
import { generateKeyPair, loadIdentity, saveIdentity } from "../src/identity.ts"
import { createNode } from "../src/index.ts"

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
  // T-34: refuse what the hub would reject, before the one outbound call.
  validateAdvertisements({ harnesses: options.harnesses })
  validateEnrollment(options.name, options.labels)
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

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

if (import.meta.main) {
  const [command] = process.argv.slice(2)
  const file = loadConfigFile()
  if (command === "enroll") {
    const token = process.env.AGENTICFORM_ENROLL_TOKEN
    if (!token) {
      console.error("AGENTICFORM_ENROLL_TOKEN is required")
      process.exit(1)
    }
    const harnesses =
      process.env.AGENTICFORM_NODE_HARNESSES !== undefined
        ? list(process.env.AGENTICFORM_NODE_HARNESSES)
        : (file.node?.harnesses ?? [])
    const enrolled = await enroll(loadConfig(), {
      token,
      name: process.env.AGENTICFORM_NODE_NAME ?? file.node?.name ?? hostname(),
      harnesses,
    })
    console.log(`enrolled node ${enrolled.nodeId}`)
  } else if (command === undefined || command === "run" || command === "start") {
    const config = loadConfig()
    const identity = loadIdentity(config.stateDir)
    if (!identity) {
      console.error("node is not enrolled; run `agenticform-node enroll` first")
      process.exit(1)
    }
    const slots = Number(process.env.AGENTICFORM_NODE_SLOTS ?? file.node?.slots ?? 1)
    const capabilities =
      process.env.AGENTICFORM_NODE_CAPABILITIES !== undefined
        ? list(process.env.AGENTICFORM_NODE_CAPABILITIES)
        : (file.node?.capabilities ?? [])
    const harnesses =
      process.env.AGENTICFORM_NODE_HARNESSES !== undefined
        ? list(process.env.AGENTICFORM_NODE_HARNESSES)
        : (file.node?.harnesses ?? [])
    validateAdvertisements({ capabilities, harnesses })
    const node = createNode(config, identity, {
      capabilities,
      harnesses,
      slots: Number.isInteger(slots) && slots > 0 ? slots : 1,
    })
    node.start()
    console.log(`node ${identity.nodeId} connected to ${config.hubUrl}`)
    const shutdown = async () => {
      await node.stop()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  } else {
    console.error("usage: agenticform-node [enroll|run]")
    process.exit(1)
  }
}
