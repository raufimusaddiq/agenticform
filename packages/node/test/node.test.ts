import { afterEach, describe, expect, test } from "bun:test"
import { createPublicKey, verify } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandEnvelope, EventBatchResponse, HeartbeatRequest, RunEventInput } from "@agenticform/protocol"
import { canonicalString } from "@agenticform/protocol/canonical"
import {
  createRuntime,
  type Capabilities,
  type DriverConnection,
  type HarnessDefinition,
  type RuntimeDriver,
} from "@agenticform/runtime"
import { NodeClient, NodeClientError } from "../src/client.ts"
import type { NodeConfig } from "../src/config.ts"
import { EventBatcher, normaliseEvent } from "../src/events.ts"
import { Executor } from "../src/executor.ts"
import { startHeartbeat } from "../src/heartbeat.ts"
import { generateKeyPair, type NodeIdentity } from "../src/identity.ts"
import { createNode } from "../src/node.ts"
import { startPoller } from "../src/poller.ts"
import { fingerprintOf } from "../src/state.ts"

const stateDir = mkdtempSync(join(tmpdir(), "af-node-test-"))
afterEach(() => rmSync(stateDir, { recursive: true, force: true }))
const hasBwrap = Bun.spawnSync(["sh", "-c", "command -v bwrap"]).exitCode === 0

const config = (hubUrl: string): NodeConfig => ({
  hubUrl,
  stateDir,
  heartbeatIntervalMs: 15_000,
  pollMs: 1_500,
  leaseRenewMs: 300_000,
  requestTimeoutMs: 5_000,
  harnessProbeTtlMs: 300_000,
  harnessProbeReadyTtlMs: 3_600_000,
  harnessProbeTimeoutMs: 20_000,
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
  createRuntime({ driver, harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } } })

/** A run that stays active until cancelled, so fencing can be observed. */
const blockingDriver = (): { driver: RuntimeDriver; cancelled: () => number; started: Promise<void> } => {
  let cancelCount = 0
  let release: (() => void) | undefined
  let markStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const driver: RuntimeDriver = {
    async connect(): Promise<DriverConnection> {
      return {
        capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
        async openSession() {},
        async prompt() {
          markStarted?.()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { stopReason: "cancelled" }
        },
        async cancel() {
          cancelCount += 1
          release?.()
        },
        async close() {},
        stderrTail() {
          return ""
        },
      }
    },
  }
  return { driver, cancelled: () => cancelCount, started }
}

/** Each connection blocks independently, so two generations can be observed. */
const generationDriver = (): {
  driver: RuntimeDriver
  firstStarted: Promise<void>
  secondStarted: Promise<void>
  cancelled: () => number
} => {
  let started = 0
  let cancelCount = 0
  let markFirst: (() => void) | undefined
  let markSecond: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => {
    markFirst = resolve
  })
  const secondStarted = new Promise<void>((resolve) => {
    markSecond = resolve
  })
  const driver: RuntimeDriver = {
    async connect(): Promise<DriverConnection> {
      let release: (() => void) | undefined
      return {
        capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
        async openSession() {},
        async prompt() {
          started += 1
          if (started === 1) markFirst?.()
          if (started === 2) markSecond?.()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { stopReason: "cancelled" }
        },
        async cancel() {
          cancelCount += 1
          release?.()
        },
        async close() {},
        stderrTail() {
          return ""
        },
      }
    },
  }
  return { driver, firstStarted, secondStarted, cancelled: () => cancelCount }
}

/** Builds a command with the payload fingerprint the node recomputes (N5.3). */
const command = (overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => {
  const payload = {
    fingerprint: "",
    generation: 1,
    harness: "fake",
    cwd: tmpdir(),
    prompt: "go",
    requires: [],
    mcpServers: [],
    ...overrides.payload,
  }
  const envelope: CommandEnvelope = {
    commandId: "cmd-1",
    type: "run.start",
    runId: "run-1",
    generation: 1,
    idempotencyKey: "run:run-1:run.start:1",
    leasedUntil: new Date().toISOString(),
    leaseId: "lease-1",
    ...overrides,
    payload,
  }
  return { ...envelope, payload: { ...payload, fingerprint: fingerprintOf(envelope) } }
}

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

  test("a 204 is null only for the optional command poll", async () => {
    const client = new NodeClient(config("http://127.0.0.1:1"), identity(), {
      fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    })
    expect(await client.nextCommand()).toBeNull()
    const error = await client
      .heartbeat({
        protocolVersion: 1,
        harnesses: [],
        capabilities: [],
        capacity: { slots: 1, inUse: 0 },
        runtimes: [],
      })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NodeClientError)
    expect((error as NodeClientError).status).toBe(204)
  })

  test("aborts an in-flight request through the caller's signal", async () => {
    const controller = new AbortController()
    let fetchSignal: AbortSignal | undefined
    const client = new NodeClient(config("http://127.0.0.1:1"), identity(), {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      }) as unknown as typeof fetch,
    })
    const pending = client.complete("cmd-1", { leaseId: "lease-1", status: "succeeded" }, controller.signal)
    await Bun.sleep(1)
    controller.abort(new Error("stop"))
    const error = await pending.catch((caught: unknown) => caught)
    expect(fetchSignal?.aborted).toBe(true)
    expect(error).toBeInstanceOf(Error)
  })

  test("threads the caller's signal into a backoff sleep", async () => {
    const controller = new AbortController()
    let sleepSignal: AbortSignal | undefined
    const client = new NodeClient(config("http://127.0.0.1:1"), identity(), {
      maxAttempts: 3,
      baseBackoffMs: 1,
      fetch: (async () => {
        throw new Error("network down")
      }) as unknown as typeof fetch,
      sleep: async (_ms, signal) => {
        sleepSignal = signal
        controller.abort(new Error("stop"))
        throw new Error("aborted")
      },
    })
    const error = await client
      .complete("cmd-1", { leaseId: "lease-1", status: "succeeded" }, controller.signal)
      .catch((caught: unknown) => caught)
    expect(sleepSignal).toBe(controller.signal)
    expect(error).toBeInstanceOf(Error)
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

  test("spawns every run through bwrap", async () => {
    const captured: { harness?: HarnessDefinition } = {}
    const driver: RuntimeDriver = {
      async connect(input): Promise<DriverConnection> {
        captured.harness = input.harness
        return {
          capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
          async openSession() {},
          async prompt() {
            return { stopReason: "end_turn" }
          },
          async cancel() {},
          async close() {},
          stderrTail() {
            return ""
          },
        }
      },
    }
    const executor = new Executor({
      runtime: createRuntime({ driver, harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } } }),
    })
    const outcome = await executor.execute(command(), { emit: () => {}, signal: new AbortController().signal })
    expect(outcome.status).toBe("succeeded")
    expect(captured.harness?.command).toBe("bwrap")
    expect(captured.harness?.args).toContain("--")
    expect(captured.harness?.args).toContain("--clearenv")
  })

  test("fails a run whose working directory is missing, before the harness starts", async () => {
    let connected = 0
    const executor = new Executor({ runtime: runtime(fakeDriver(() => (connected += 1))) })
    const outcome = await executor.execute(
      command({ payload: { ...command().payload, cwd: join(stateDir, "absent") } }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    expect(outcome.status).toBe("failed")
    expect(outcome.error?.code).toBe("workspace_missing")
    expect(connected).toBe(0)
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

  test("applies the payload generation check to cancel and inspect", async () => {
    const executor = new Executor({ runtime: runtime() })
    for (const type of ["run.cancel", "run.inspect"] as const) {
      const outcome = await executor.execute(
        command({ type, generation: 2, payload: { fingerprint: "sha256:x", generation: 1 } }),
        { emit: () => {}, signal: new AbortController().signal },
      )
      expect(outcome).toEqual({
        status: "failed",
        error: { code: "fence_stale", message: "payload generation differs from envelope" },
      })
    }
    expect(executor.staleObservations).toBe(2)
  })

  test("refuses a stale run.cancel without touching the active run", async () => {
    const blocking = blockingDriver()
    const executor = new Executor({ runtime: runtime(blocking.driver) })
    const start = executor.execute(
      command({ generation: 2, payload: { ...command().payload, generation: 2 } }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    await blocking.started

    const stale = await executor.execute(
      command({
        commandId: "cmd-cancel-stale",
        type: "run.cancel",
        generation: 1,
        payload: { fingerprint: "sha256:x", generation: 1 },
      }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    expect(stale).toEqual({
      status: "failed",
      error: { code: "fence_stale", message: "command generation is older than the active run" },
    })
    expect(blocking.cancelled()).toBe(0)
    expect(executor.staleObservations).toBe(1)

    const fresh = await executor.execute(
      command({
        commandId: "cmd-cancel-fresh",
        type: "run.cancel",
        generation: 2,
        payload: { fingerprint: "sha256:x", generation: 2 },
      }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    expect(fresh.status).toBe("succeeded")
    expect(blocking.cancelled()).toBe(1)
    expect((await start).status).toBe("succeeded")
  })

  test("refuses a stale run.inspect and records it", async () => {
    const blocking = blockingDriver()
    const executor = new Executor({ runtime: runtime(blocking.driver) })
    const start = executor.execute(
      command({ generation: 2, payload: { ...command().payload, generation: 2 } }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    await blocking.started

    const stale = await executor.execute(
      command({
        commandId: "cmd-inspect-stale",
        type: "run.inspect",
        generation: 1,
        payload: { fingerprint: "sha256:x", generation: 1 },
      }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    expect(stale.status).toBe("failed")
    expect(executor.staleObservations).toBe(1)

    const fresh = await executor.execute(
      command({
        commandId: "cmd-inspect-fresh",
        type: "run.inspect",
        generation: 2,
        payload: { fingerprint: "sha256:x", generation: 2 },
      }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    expect(fresh.status).toBe("succeeded")

    await executor.cancel(
      command({
        commandId: "cmd-inspect-cancel",
        type: "run.cancel",
        generation: 2,
        payload: { fingerprint: "sha256:x", generation: 2 },
      }),
    )
    await start
  })

  test("inspect reports an absent run distinctly", () => {
    const executor = new Executor({ runtime: runtime() })
    const outcome = executor.inspect(
      command({ type: "run.inspect", generation: 1, payload: { fingerprint: "sha256:x", generation: 1 } }),
    )
    expect(outcome).toEqual({
      status: "succeeded",
      result: { status: "absent", runId: "run-1", state: "absent", generation: null },
    })
  })

  test("a newer run.start fences the old generation and owns the run", async () => {
    const generations = generationDriver()
    const executor = new Executor({ runtime: runtime(generations.driver) })
    const first = executor.execute(
      command({ generation: 1, payload: { ...command().payload, generation: 1 } }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    await generations.firstStarted

    const second = executor.execute(
      command({ commandId: "cmd-2", generation: 2, payload: { ...command().payload, generation: 2 } }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    await generations.secondStarted
    expect(generations.cancelled()).toBe(1)
    expect(executor.inventory()).toEqual([
      { runId: "run-1", generation: 2, runtimeType: "fake", runtimeSessionId: "", state: "running" },
    ])

    const inspect = executor.inspect(
      command({
        commandId: "cmd-inspect",
        type: "run.inspect",
        generation: 2,
        payload: { fingerprint: "sha256:x", generation: 2 },
      }),
    )
    expect(inspect.result).toMatchObject({ status: "inspected", generation: 2, state: "running" })

    const stale = await executor.execute(
      command({ commandId: "cmd-stale", generation: 1, payload: { ...command().payload, generation: 1 } }),
      { emit: () => {}, signal: new AbortController().signal },
    )
    expect(stale).toEqual({
      status: "failed",
      error: { code: "fence_stale", message: "run.start generation is not newer than the active run" },
    })
    expect(executor.staleObservations).toBe(1)

    const cancel = await executor.cancel(
      command({
        commandId: "cmd-cancel",
        type: "run.cancel",
        generation: 2,
        payload: { fingerprint: "sha256:x", generation: 2 },
      }),
    )
    expect(cancel.status).toBe("succeeded")
    expect((await first).status).toBe("succeeded")
    expect((await second).status).toBe("succeeded")
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

  test("surfaces a completion that stays events_pending after retries", async () => {
    const executor = new Executor({ runtime: runtime() })
    const errors: unknown[] = []
    let attempts = 0
    let delivered = false
    const done = new Promise<void>((resolve) => {
      const client = {
        async nextCommand() {
          if (delivered) return null
          delivered = true
          return command()
        },
        async appendEvents(_commandId: string, batch: { events: RunEventInput[] }) {
          return { accepted: batch.events.length, lastSeq: batch.events.length }
        },
        async complete() {
          attempts += 1
          throw new NodeClientError(409, "events_pending", "events are not persisted yet")
        },
        async renew() {
          return { leasedUntil: new Date().toISOString() }
        },
      }
      const poller = startPoller(client as never, {
        pollMs: 5,
        leaseRenewMs: 60_000,
        executor,
        onError: (error) => {
          errors.push(error)
          if (attempts >= 3) resolve()
        },
      })
      stop = () => void poller.stop()
    })
    await done
    expect(attempts).toBe(3)
    expect(
      errors.filter(
        (error) => error instanceof Error && error.message === "completion still pending after retries",
      ),
    ).toHaveLength(1)
  })

  test("reserves a slot before leasing and polls only non-start commands when full", async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const driver: RuntimeDriver = {
      async connect(): Promise<DriverConnection> {
        return {
          capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
          async openSession() {},
          async prompt() {
            concurrent += 1
            maxConcurrent = Math.max(maxConcurrent, concurrent)
            await Bun.sleep(30)
            concurrent -= 1
            return { stopReason: "end_turn" }
          },
          async cancel() {},
          async close() {},
          stderrTail() {
            return ""
          },
        }
      },
    }
    const executor = new Executor({ runtime: runtime(driver) })
    const commands = [
      command({ commandId: "cmd-1", runId: "run-1" }),
      command({ commandId: "cmd-2", runId: "run-2", idempotencyKey: "run:run-2:run.start:1" }),
    ]
    let index = 0
    let completed = 0
    const polls: (readonly string[] | undefined)[] = []
    const done = new Promise<void>((resolve) => {
      const client = {
        async nextCommand(types?: readonly string[]) {
          polls.push(types)
          if (types && types.length > 0) return null
          return commands[index++] ?? null
        },
        async appendEvents(_commandId: string, batch: { events: RunEventInput[] }) {
          return { accepted: batch.events.length, lastSeq: batch.events.length }
        },
        async complete() {
          completed += 1
          if (completed === 2) resolve()
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
        slots: 1,
      })
      stop = () => void poller.stop()
    })
    await done
    expect(maxConcurrent).toBe(1)
    expect(completed).toBe(2)
    expect(polls.some((types) => types?.includes("run.cancel"))).toBe(true)
    expect(polls.filter((types) => types === undefined).length).toBeGreaterThanOrEqual(2)
  })

  test("stop aborts a parked run.start before it executes", async () => {
    let connects = 0
    let prompts = 0
    let cancelled = 0
    let release: (() => void) | undefined
    let markFirst: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      markFirst = resolve
    })
    const driver: RuntimeDriver = {
      async connect(): Promise<DriverConnection> {
        connects += 1
        return {
          capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
          async openSession() {},
          async prompt() {
            prompts += 1
            markFirst?.()
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return { stopReason: "cancelled" }
          },
          async cancel() {
            cancelled += 1
            release?.()
          },
          async close() {},
          stderrTail() {
            return ""
          },
        }
      },
    }
    const executor = new Executor({ runtime: runtime(driver) })
    const commands = [
      command({ commandId: "cmd-1", runId: "run-1" }),
      command({ commandId: "cmd-2", runId: "run-2", idempotencyKey: "run:run-2:run.start:1" }),
    ]
    let index = 0
    const errors: unknown[] = []
    const completed: string[] = []
    const client = {
      // Ignores the type filter on purpose, forcing the second start to park.
      async nextCommand() {
        return commands[index++] ?? null
      },
      async appendEvents(_commandId: string, batch: { events: RunEventInput[] }) {
        return { accepted: batch.events.length, lastSeq: batch.events.length }
      },
      async complete(commandId: string) {
        completed.push(commandId)
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
      slots: 1,
      onError: (error) => errors.push(error),
    })
    await firstStarted
    await Bun.sleep(30)
    await poller.stop()
    expect(prompts).toBe(1)
    expect(connects).toBe(1)
    expect(cancelled).toBe(1)
    expect(completed).toEqual(["cmd-1"])
    expect(errors.some((error) => error instanceof Error && error.message === "poller stopped")).toBe(true)
  })

  test("stop resolves promptly when a completion hangs", async () => {
    const executor = new Executor({ runtime: runtime() })
    let delivered = false
    let markComplete: (() => void) | undefined
    const completeStarted = new Promise<void>((resolve) => {
      markComplete = resolve
    })
    const client = {
      async nextCommand() {
        if (delivered) return null
        delivered = true
        return command()
      },
      async appendEvents(_commandId: string, batch: { events: RunEventInput[] }) {
        return { accepted: batch.events.length, lastSeq: batch.events.length }
      },
      async complete() {
        markComplete?.()
        return new Promise(() => {})
      },
      async renew() {
        return { leasedUntil: new Date().toISOString() }
      },
    }
    const poller = startPoller(client as never, {
      pollMs: 5,
      leaseRenewMs: 60_000,
      executor,
      stopTimeoutMs: 50,
    })
    await completeStarted
    const begin = Date.now()
    await poller.stop()
    expect(Date.now() - begin).toBeLessThan(500)
  })
})

describe("shutdown", () => {
  test("heartbeat stop aborts and awaits an in-flight beat", async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let aborted = false
    const client = {
      heartbeat(_body: unknown, signal?: AbortSignal) {
        markStarted?.()
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new Error("aborted"))
            },
            { once: true },
          )
        })
      },
    }
    const loop = startHeartbeat(client as never, {
      intervalMs: 60_000,
      body: () => ({
        protocolVersion: 1,
        harnesses: [],
        capabilities: [],
        capacity: { slots: 1, inUse: 0 },
        runtimes: [],
      }),
    })
    await started
    await loop.stop()
    expect(aborted).toBe(true)
  })

  test("node stop awaits an in-flight heartbeat", async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/v1/node/heartbeat")) {
        markStarted?.()
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const node = createNode({ ...config("http://127.0.0.1:1"), harnessProbeTimeoutMs: 50 }, identity(), {
      fetch: fetchImpl,
      runtime: runtime(),
    })
    node.start()
    await started
    const begin = Date.now()
    await node.stop()
    expect(Date.now() - begin).toBeLessThan(500)
  })
})

describe("first heartbeat", () => {
  test.skipIf(!hasBwrap)("waits for the first probe pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-slow-"))
    const slow = join(dir, "slow")
    writeFileSync(slow, "#!/bin/sh\nsleep 300\n", { mode: 0o755 })
    const bodies: HeartbeatRequest[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/v1/node/heartbeat")) {
        bodies.push(JSON.parse(String(init?.body)) as HeartbeatRequest)
        return Response.json({ status: "online", commandsPollMs: 60_000 })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const node = createNode(
      { ...config("http://127.0.0.1:1"), harnessProbeTimeoutMs: 100, heartbeatIntervalMs: 60_000, pollMs: 60_000 },
      identity(),
      {
        fetch: fetchImpl,
        runtime: createRuntime({ harnesses: { slow: { id: "slow", profile: "coding", command: slow } } }),
        harnesses: ["slow"],
      },
    )
    try {
      node.start()
      for (let i = 0; i < 100 && bodies.length === 0; i += 1) await Bun.sleep(20)
      expect(bodies.length).toBeGreaterThan(0)
      expect(bodies[0]?.harnessReport).toEqual([{ id: "slow", status: "unknown", reason: "handshake_timeout" }])
    } finally {
      await node.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
