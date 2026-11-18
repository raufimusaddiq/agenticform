import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { CommandEnvelope, RunEventInput } from "@agenticform/protocol"
import {
  createRuntime,
  type Capabilities,
  type DriverConnection,
  type RuntimeDriver,
} from "@agenticform/runtime"
import { Executor } from "../src/executor.ts"
import { fingerprintOf } from "../src/state.ts"

/** The Executor refuses every run without a passing self-test (FR-014). */
const SANDBOX = { mode: "bwrap", selfTest: "pass" } as const

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

/**
 * A driver that asks permission the way the ACP driver does: emit
 * `permission.requested`, await `sink.decide` (the runtime's own handler and
 * timeout), then emit `permission.resolved`. The harness is in-process, so the
 * test needs no sandbox binary; the runtime, executor and ledger are real.
 */
const permissionDriver = (): RuntimeDriver => ({
  async connect(_input, sink): Promise<DriverConnection> {
    return {
      capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
      async openSession() {},
      async prompt() {
        const request = { toolCallId: "tool-1", title: "Write file", kind: "edit" }
        sink.emit({ type: "permission.requested", request })
        const decision = await sink.decide(request)
        sink.emit({ type: "permission.resolved", toolCallId: request.toolCallId, decision })
        sink.emit({ type: "message.delta", text: decision })
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

const executor = (permissionTimeoutMs?: number): Executor =>
  new Executor({
    isolation: SANDBOX,
    runtime: createRuntime({
      driver: permissionDriver(),
      harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } },
    }),
    ...(permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs }),
  })

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
    leasedUntil: new Date(Date.now() + 60_000).toISOString(),
    leaseId: "lease-1",
    ...overrides,
    payload,
  }
  return { ...envelope, payload: { ...payload, fingerprint: fingerprintOf(envelope) } }
}

const answerCommand = (decision: "allow" | "deny", commandId = `answer-${decision}`): CommandEnvelope =>
  command({
    commandId,
    type: "permission.answer",
    idempotencyKey: "run:run-1:permission.answer:tool-1:1",
    payload: { fingerprint: "", generation: 1, toolCallId: "tool-1", decision },
  })

const waitUntil = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const start = Date.now()
  while (!condition() && Date.now() - start < timeoutMs) await Bun.sleep(10)
}

const context = (events: RunEventInput[]) => ({
  emit: (event: RunEventInput) => events.push(event),
  signal: new AbortController().signal,
})

describe("remote permission answers (T021)", () => {
  test("allow reaches the harness", async () => {
    const events: RunEventInput[] = []
    const node = executor()
    const running = node.execute(command(), context(events))
    await waitUntil(() => events.some((event) => event.type === "permission.requested"))
    const answered = await node.execute(answerCommand("allow"), context([]))
    expect(answered).toEqual({ status: "succeeded", result: { applied: true } })
    const outcome = await running
    expect(outcome.result).toMatchObject({ status: "completed", text: "allow" })
    expect(events.some((event) => event.type === "permission.resolved")).toBe(true)
  })

  test("deny reaches the harness", async () => {
    const events: RunEventInput[] = []
    const node = executor()
    const running = node.execute(command(), context(events))
    await waitUntil(() => events.some((event) => event.type === "permission.requested"))
    expect(await node.execute(answerCommand("deny"), context([]))).toEqual({
      status: "succeeded",
      result: { applied: true },
    })
    expect((await running).result).toMatchObject({ text: "deny" })
  })

  test("no answer is denied at the runtime's timeout", async () => {
    const events: RunEventInput[] = []
    const node = executor(50)
    const outcome = await node.execute(command(), context(events))
    expect(outcome.result).toMatchObject({ text: "deny" })
    // The waiter is gone, so a late answer is not applied.
    expect(await node.execute(answerCommand("allow"), context([]))).toEqual({
      status: "succeeded",
      result: { applied: false },
    })
  })

  test("a duplicate answer completes applied:false", async () => {
    const events: RunEventInput[] = []
    const node = executor()
    const running = node.execute(command(), context(events))
    await waitUntil(() => events.some((event) => event.type === "permission.requested"))
    const first = await node.execute(answerCommand("allow", "answer-1"), context([]))
    const second = await node.execute(answerCommand("allow", "answer-2"), context([]))
    expect(first).toEqual({ status: "succeeded", result: { applied: true } })
    expect(second).toEqual({ status: "succeeded", result: { applied: false } })
    await running
  })

  test("an answer for an unknown request is applied:false, not an error", async () => {
    const outcome = await executor().execute(answerCommand("allow"), context([]))
    expect(outcome).toEqual({ status: "succeeded", result: { applied: false } })
  })
})
