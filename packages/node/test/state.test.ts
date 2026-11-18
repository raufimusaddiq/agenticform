import { describe, expect, test } from "bun:test"
import type { CommandEnvelope } from "@agenticform/protocol"
import {
  createRuntime,
  type Capabilities,
  type DriverConnection,
  type RuntimeDriver,
} from "@agenticform/runtime"
import { Executor } from "../src/executor.ts"
import { NodeState, fingerprintOf, payloadGenerationError } from "../src/state.ts"

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

const countingDriver = (): { driver: RuntimeDriver; connected: () => number } => {
  let count = 0
  return {
    connected: () => count,
    driver: {
      async connect(): Promise<DriverConnection> {
        count += 1
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
    },
  }
}

const runtime = (driver: RuntimeDriver) =>
  createRuntime({ driver, harnesses: { fake: { id: "fake", profile: "coding", command: "fake" } } })

const command = (overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
  commandId: "cmd-1",
  type: "run.start",
  runId: "run-1",
  generation: 1,
  idempotencyKey: "run:run-1:run.start:1",
  leasedUntil: new Date().toISOString(),
  leaseId: "lease-1",
  payload: { fingerprint: "sha256:x", generation: 1, harness: "fake", cwd: "/tmp", prompt: "go" },
  ...overrides,
})

const context = () => ({ emit: () => {}, signal: new AbortController().signal })

describe("node state", () => {
  test("detects a payload generation that differs from the envelope", () => {
    expect(payloadGenerationError(command())).toBeNull()
    expect(payloadGenerationError(command({ generation: 2 }))).toBe(
      "payload generation differs from envelope",
    )
  })

  test("keeps runtime generations monotonic", () => {
    const state = new NodeState()
    expect(state.currentGeneration("run-1")).toBeNull()
    expect(state.advance("run-1", 2)).toBe(true)
    expect(state.advance("run-1", 1)).toBe(false)
    expect(state.currentGeneration("run-1")).toBe(2)
  })

  test("admits a command once, replays it, then conflicts on a changed payload", () => {
    const state = new NodeState()
    expect(state.admit(command())).toBe("new")
    expect(state.admit(command())).toBe("replay")
    expect(state.admit(command({ payload: { ...command().payload, prompt: "other" } }))).toBe("conflict")
  })

  test("fingerprint covers type, idempotency key, generation and payload", () => {
    const base = fingerprintOf(command())
    expect(fingerprintOf(command({ type: "run.inspect" }))).not.toBe(base)
    expect(fingerprintOf(command({ idempotencyKey: "other" }))).not.toBe(base)
    expect(fingerprintOf(command({ generation: 2, payload: { ...command().payload, generation: 2 } }))).not.toBe(base)
    expect(fingerprintOf(command({ payload: { ...command().payload, prompt: "other" } }))).not.toBe(base)
  })
})

describe("executor reuse and monotonic fencing", () => {
  test("refuses a reused command id with a different fingerprint before any effect", async () => {
    const counting = countingDriver()
    const executor = new Executor({ runtime: runtime(counting.driver) })
    const first = await executor.execute(command(), context())
    expect(first.status).toBe("succeeded")
    expect(counting.connected()).toBe(1)

    const reused = await executor.execute(
      command({ payload: { ...command().payload, prompt: "different" } }),
      context(),
    )
    expect(reused).toEqual({
      status: "failed",
      error: { code: "idempotency_conflict", message: "command id reused with a different fingerprint" },
    })
    expect(counting.connected()).toBe(1)
  })

  test("an older generation never replaces the recorded runtime", async () => {
    const counting = countingDriver()
    const executor = new Executor({ runtime: runtime(counting.driver) })
    const newer = await executor.execute(
      command({ commandId: "cmd-2", generation: 2, payload: { ...command().payload, generation: 2 } }),
      context(),
    )
    expect(newer.status).toBe("succeeded")

    const older = await executor.execute(
      command({ commandId: "cmd-old", generation: 1, payload: { ...command().payload, generation: 1 } }),
      context(),
    )
    expect(older.status).toBe("failed")
    expect(older.error?.code).toBe("fence_stale")
    expect(counting.connected()).toBe(1)
    expect(executor.inventory()).toEqual([])
  })
})
