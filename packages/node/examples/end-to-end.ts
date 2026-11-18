/**
 * End-to-end example: a fake hub, a fake agent and a real node.
 *
 *   bun packages/node/examples/end-to-end.ts
 *
 * The hub verifies every signature, leases one `run.start`, accepts the event
 * batch and the completion. The agent is a `RuntimeDriver` that emits one
 * message and ends its turn, so no harness is installed or logged in. Nothing
 * listens on the node side: the node only makes outbound calls (FR-001).
 */
import { createPublicKey, verify } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandEnvelope, CompletionRequest, RunEventInput } from "@agenticform/protocol"
import { canonicalString } from "@agenticform/protocol/canonical"
import {
  createRuntime,
  type Capabilities,
  type DriverConnection,
  type RuntimeDriver,
} from "@agenticform/runtime"
import { generateKeyPair, type NodeIdentity } from "../src/identity.ts"
import { createNode } from "../src/node.ts"
import { fingerprintOf } from "../src/state.ts"

const supported: Capabilities["supported"] = {
  cancel: true,
  "steer.emulated": false,
  "mcp.stdio": false,
  "mcp.http": false,
  "mcp.sse": false,
  "session.load": false,
  "session.resume": false,
  "prompt.image": false,
  "prompt.embeddedContext": false,
}

/** A fake agent: one message, then `end_turn`. */
const fakeAgent = (): RuntimeDriver => ({
  async connect(_input, sink): Promise<DriverConnection> {
    return {
      capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
      async openSession() {},
      async prompt() {
        sink.emit({ type: "message.delta", text: "hello from the fake agent" })
        return { stopReason: "end_turn" }
      },
      async cancel() {},
      async close() {},
      stderrTail() {
        return ""
      },
    }
  },
})

const stateDir = mkdtempSync(join(tmpdir(), "af-example-"))
// The probe runs a real sandboxed ACP child, so the fake harness is a real
// executable script. The run itself still uses the in-process fake driver.
const fakeEntry = join(stateDir, "fake-harness")
writeFileSync(
  fakeEntry,
  `#!/usr/bin/env bun\n${readFileSync(join(import.meta.dir, "..", "test", "fake-harness.ts"), "utf8")}`,
  { mode: 0o755 },
)
const identity: NodeIdentity = {
  ...generateKeyPair(),
  nodeId: "3f1c2a9e-0000-4000-8000-000000000001",
  hubUrl: "",
}
const publicKey = createPublicKey({
  key: Buffer.from(identity.publicKeyB64, "base64"),
  format: "der",
  type: "spki",
})

const command: CommandEnvelope = {
  commandId: "cmd-1",
  type: "run.start",
  runId: "run-1",
  generation: 1,
  idempotencyKey: "run:run-1:run.start:1",
  leasedUntil: new Date(Date.now() + 60_000).toISOString(),
  leaseId: "lease-1",
  payload: {
    fingerprint: "",
    generation: 1,
    harness: "fake",
    cwd: stateDir,
    prompt: "say hello",
    requires: [],
    mcpServers: [],
  },
}
command.payload.fingerprint = fingerprintOf(command)

const seenNonces = new Set<string>()
const events: RunEventInput[] = []
let leased = false
let advertised: string[] = []
let completion: CompletionRequest | undefined
let markDone: (() => void) | undefined
const done = new Promise<void>((resolve) => {
  markDone = resolve
})

const hub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const raw = await request.text()
    const path = new URL(request.url).pathname + new URL(request.url).search
    const nonce = request.headers.get("x-af-nonce") ?? ""
    const canonical = canonicalString({
      nodeId: request.headers.get("x-af-node-id") ?? "",
      timestampMs: Number(request.headers.get("x-af-timestamp")),
      nonce,
      method: request.method,
      path,
      body: raw,
    })
    const signed = verify(
      null,
      Buffer.from(canonical),
      publicKey,
      Buffer.from(request.headers.get("x-af-signature") ?? "", "base64"),
    )
    // A replay is a machine authentication failure, indistinguishable from a
    // bad signature (N8.4).
    if (!signed || seenNonces.has(nonce)) {
      return Response.json({ error: { code: "unauthorized", message: "unauthorized" } }, { status: 401 })
    }
    seenNonces.add(nonce)

    if (path === "/v1/node/heartbeat") {
      advertised = (JSON.parse(raw) as { harnesses: string[] }).harnesses
      return Response.json({ status: "online", commandsPollMs: 1_500 })
    }
    if (path === "/v1/node/commands/next") {
      // Placement only sees advertised harnesses, so wait for the probe.
      if (leased || !advertised.includes("fake")) return new Response(null, { status: 204 })
      leased = true
      return Response.json(command)
    }
    if (path.endsWith("/renew")) {
      return Response.json({ leasedUntil: new Date(Date.now() + 60_000).toISOString() })
    }
    if (path.endsWith("/events")) {
      const batch = JSON.parse(raw) as { events: RunEventInput[] }
      events.push(...batch.events)
      return Response.json({ accepted: batch.events.length, lastSeq: events.length })
    }
    if (path.endsWith("/complete")) {
      completion = JSON.parse(raw) as CompletionRequest
      markDone?.()
      return Response.json({ ok: true })
    }
    return new Response(null, { status: 404 })
  },
})

const node = createNode(
  {
    hubUrl: `http://127.0.0.1:${hub.port}`,
    stateDir,
    heartbeatIntervalMs: 60_000,
    pollMs: 50,
    leaseRenewMs: 60_000,
    requestTimeoutMs: 5_000,
    harnessProbeTtlMs: 300_000,
    harnessProbeTimeoutMs: 20_000,
    protocolVersion: 1,
  },
  identity,
  {
    runtime: createRuntime({
      driver: fakeAgent(),
      harnesses: { fake: { id: "fake", profile: "coding", command: fakeEntry, args: [JSON.stringify({})] } },
    }),
    harnesses: ["fake"],
  },
)

node.start()
await done
// Let the poller finish the in-flight command before stopping it.
await new Promise((resolve) => setTimeout(resolve, 100))
await node.stop()
hub.stop(true)
rmSync(stateDir, { recursive: true, force: true })

for (const event of events) console.log(`${event.type}: ${JSON.stringify(event.data)}`)
console.log(`completion: ${completion?.status} ${JSON.stringify(completion?.result)}`)
