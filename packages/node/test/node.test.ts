import { afterEach, describe, expect, test } from "bun:test"
import { createPublicKey, verify } from "node:crypto"
import { tmpdir } from "node:os"
import type { CommandEnvelope, EventBatchResponse, RunEventInput } from "@agenticform/protocol"
import { canonicalString } from "@agenticform/protocol/canonical"
import {
  createRuntime,
  type Capabilities,
  type DriverConnection,
  type RuntimeDriver,
} from "@agenticform/runtime"
import { NodeClient, NodeClientError } from "../src/client.ts"
import type { NodeConfig } from "../src/config.ts"
import { EventBatcher, normaliseEvent } from "../src/events.ts"
import { Executor } from "../src/executor.ts"
import { generateKeyPair, type NodeIdentity } from "../src/identity.ts"
import { startPoller } from "../src/poller.ts"

const config = (hubUrl: string): NodeConfig => ({
  hubUrl,
  stateDir: tmpdir(),
  heartbeatIntervalMs: 15_000,
  pollMs: 1_500,
  leaseRenewMs: 300_000,
  requestTimeoutMs: 5_000,
  protocolVersion: 1,
})

const identity = (): NodeIdentity => ({
  ...generateKeyPair(),
  nodeId: "3f1c2a9e-0000-4000-8000-000000000001",
  hubUrl: "",
})

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

const fakeDriver = (onConnect?: () => void): RuntimeDriver => ({
  async connect(_input, sink): Promise<DriverConnection> {
    onConnect?.()
    return {
      capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
      async openSession() {},
      async prompt() {
        sink.emit({ type: "message.delta", text: "hello" })
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

const runtime = (driver: RuntimeDriver = fakeDriver()) =>
  createRuntime({ driver, harnesses: { fake: { id: "fake", profile: "coding", command: "fake" } } })

const command = (overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
  commandId: "cmd-1",
  type: "run.start",
  runId: "run-1",
  generation: 1,
  idempotencyKey: "run:run-1:run.start:1",
  leasedUntil: new Date().toISOString(),
  leaseId: "lease-1",
  payload: {
    fingerprint: "sha256:x",
    generation: 1,
    harness: "fake",
    cwd: tmpdir(),
    prompt: "go",
    requires: [],
    mcpServers: [],
  },
  ...overrides,
})

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
})

describe("signed client", () => {
  test("signs the canonical string and returns the hub response", async () => {
    const keys = identity()
    let verified = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const raw = await request.text()
        const canonical = canonicalString({
          nodeId: request.headers.get("x-af-node-id") ?? "",
          timestampMs: Number(request.headers.get("x-af-timestamp")),
          nonce: request.headers.get("x-af-nonce") ?? "",
          method: request.method,
          path: new URL(request.url).pathname,
          body: raw,
        })
        verified = verify(
          null,
          Buffer.from(canonical),
          createPublicKey({ key: Buffer.from(keys.publicKeyB64, "base64"), format: "der", type: "spki" }),
          Buffer.from(request.headers.get("x-af-signature") ?? "", "base64"),
        )
        return Response.json({ status: "online", commandsPollMs: 1_500 })
      },
    })
    stop = () => server.stop(true)

    const client = new NodeClient(config(`http://127.0.0.1:${server.port}`), keys)
    const response = await client.heartbeat({
      protocolVersion: 1,
      harnesses: ["fake"],
      capabilities: [],
      capacity: { slots: 1, inUse: 0 },
      runtimes: [],
    })
    expect(verified).toBe(true)
    expect(response).toEqual({ status: "online", commandsPollMs: 1_500 })
  })

  test("retries transport failures with backoff and a fresh nonce", async () => {
    const keys = identity()
    const nonces: string[] = []
    const sleeps: number[] = []
    let attempts = 0
    const client = new NodeClient(config("http://127.0.0.1:1"), keys, {
      maxAttempts: 3,
      baseBackoffMs: 10,
      random: () => 0,
      nonce: () => `nonce-${String(++attempts).padStart(16, "0")}`,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      fetch: (async () => {
        nonces.push(`attempt-${attempts}`)
        if (attempts < 3) throw new Error("connection refused")
        return Response.json({ status: "online", commandsPollMs: 1_500 })
      }) as unknown as typeof fetch,
    })
    const response = await client.heartbeat({
      protocolVersion: 1,
      harnesses: [],
      capabilities: [],
      capacity: { slots: 1, inUse: 0 },
      runtimes: [],
    })
    expect(response.status).toBe("online")
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([10, 20])
    expect(nonces).toHaveLength(3)
  })

  test("does not retry a 4xx decision", async () => {
    let attempts = 0
    const client = new NodeClient(config("http://127.0.0.1:1"), identity(), {
      maxAttempts: 3,
      fetch: (async () => {
        attempts += 1
        return Response.json({ error: { code: "fence_stale", message: "no" } }, { status: 409 })
      }) as unknown as typeof fetch,
    })
    const error = await client.nextCommand().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NodeClientError)
    expect((error as NodeClientError).code).toBe("fence_stale")
    expect(attempts).toBe(1)
  })
})

describe("event normalisation and batching", () => {
  test("drops the runtime terminal event and keeps a stable key", () => {
    const event = {
      type: "message.delta" as const,
      runId: "run-1",
      seq: 7,
      at: "2026-11-18T12:00:00.000Z",
      turnId: "turn-1",
      text: "ok",
    }
    expect(normaliseEvent(event, "cmd-1")).toEqual({
      key: "cmd-1:7",
      type: "message.delta",
      at: "2026-11-18T12:00:00.000Z",
      data: { type: "message.delta", turnId: "turn-1", text: "ok" },
    })
    expect(
      normaliseEvent(
        { type: "run.finished", runId: "run-1", seq: 8, at: "2026-11-18T12:00:01.000Z", result: {} as never },
        "cmd-1",
      ),
    ).toBeNull()
  })

  test("batches by size and tracks the hub's last sequence", async () => {
    const batches: RunEventInput[][] = []
    const batcher = new EventBatcher({
      maxBatch: 2,
      flushMs: 60_000,
      send: async (events): Promise<EventBatchResponse> => {
        batches.push(events)
        return { accepted: events.length, lastSeq: batches.flat().length }
      },
    })
    for (let seq = 1; seq <= 3; seq += 1) {
      batcher.add({ key: `cmd-1:${seq}`, type: "message.delta", at: "2026-11-18T12:00:00.000Z", data: {} })
    }
    await batcher.close()
    expect(batches.map((batch) => batch.length)).toEqual([2, 1])
    expect(batcher.lastSeq).toBe(3)
  })
})

describe("executor", () => {
  test("runs a command through runtime and never forwards run.finished", async () => {
    const executor = new Executor({ runtime: runtime() })
    const events: RunEventInput[] = []
    const outcome = await executor.execute(command(), {
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe("succeeded")
    expect(events.map((event) => event.type)).toContain("message.delta")
    expect(events.some((event) => event.type === "run.finished")).toBe(false)
    expect(events[0]?.key).toBe("cmd-1:1")
  })

  test("refuses a payload generation that differs from the envelope", async () => {
    let connected = 0
    const executor = new Executor({ runtime: runtime(fakeDriver(() => (connected += 1))) })
    const outcome = await executor.execute(
      command({ payload: { ...command().payload, generation: 2 } }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    expect(outcome).toEqual({
      status: "failed",
      error: { code: "fence_stale", message: "payload generation differs from envelope" },
    })
    expect(connected).toBe(0)
  })
})

describe("poller", () => {
  test("executes a leased command, flushes events and completes with eventsToSeq", async () => {
    const executor = new Executor({ runtime: runtime() })
    const appended: RunEventInput[][] = []
    let completed: Record<string, unknown> | undefined
    let delivered = false
    const done = new Promise<void>((resolve) => {
      const client = {
        async nextCommand() {
          if (delivered) return null
          delivered = true
          return command()
        },
        async appendEvents(_commandId: string, batch: { events: RunEventInput[] }) {
          appended.push(batch.events)
          return { accepted: batch.events.length, lastSeq: appended.flat().length }
        },
        async complete(_commandId: string, body: Record<string, unknown>) {
          completed = body
          resolve()
          return {}
        },
        async renew() {
          return { leasedUntil: new Date().toISOString() }
        },
      }
      const poller = startPoller(client as never, {
        pollMs: 5,
        leaseRenewMs: 60_000,
        executor,
      })
      stop = () => void poller.stop()
    })
    await done
    expect(completed?.status).toBe("succeeded")
    expect(completed?.eventsToSeq).toBe(appended.flat().length)
    expect(appended.flat().some((event) => event.type === "message.delta")).toBe(true)
  })
})
