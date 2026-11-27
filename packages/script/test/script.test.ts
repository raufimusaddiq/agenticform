import { describe, expect, test } from "bun:test"
import type {
  NodeView,
  PermissionRequestView,
  RunEventWire,
  RunRequest,
  RunView,
} from "@agenticform/protocol"
import {
  SuspendError,
  createScriptRuntime,
  validateScript,
  type ScriptRunsPort,
} from "../src/index.ts"

class FakeRunsPort implements ScriptRunsPort {
  readonly createdRequests: RunRequest[] = []
  readonly cancelledIds: string[] = []
  readonly runs = new Map<string, RunView>()
  readonly nodes: NodeView[] = [
    {
      nodeId: "n1",
      name: "alpha",
      status: "online",
      protocolVersion: 1,
      harnesses: ["codex"],
      capabilities: ["git"],
      labels: { zone: "us" },
      capacity: { slots: 4, inUse: 0 },
      lastHeartbeatAt: "2026-11-27T00:00:00.000Z",
    },
  ]
  private nextId = 1
  private autoComplete = true

  setAutoComplete(enabled: boolean): void {
    this.autoComplete = enabled
  }

  completeRun(runId: string, result: unknown): void {
    const existing = this.runs.get(runId)
    if (!existing) throw new Error(`missing run ${runId}`)
    this.runs.set(runId, { ...existing, status: "completed", result })
  }

  async listNodes(): Promise<NodeView[]> {
    return this.nodes
  }

  async createRun(request: RunRequest): Promise<RunView> {
    this.createdRequests.push(request)
    const runId = `run-${this.nextId++}`
    const view: RunView = {
      runId,
      status: this.autoComplete ? "completed" : "running",
      nodeId: "n1",
      generation: 1,
      createdAt: "2026-11-27T00:00:00.000Z",
      parentRunId: request.parentRunId ?? null,
      depth: request.parentRunId ? 1 : 0,
      ...(this.autoComplete ? { result: { summary: `done:${request.prompt}` } } : {}),
    }
    this.runs.set(runId, view)
    return view
  }

  async getRun(runId: string): Promise<RunView> {
    const run = this.runs.get(runId)
    if (!run) throw { code: "not_found", message: "run not found" }
    return run
  }

  async cancelRun(runId: string): Promise<RunView> {
    this.cancelledIds.push(runId)
    const run = await this.getRun(runId)
    const updated: RunView = { ...run, status: "cancelled" }
    this.runs.set(runId, updated)
    return updated
  }

  async getEvents(runId: string, after = 0): Promise<{ events: RunEventWire[]; lastSeq: number }> {
    return {
      events: [
        {
          seq: after + 1,
          key: `ev-${after + 1}`,
          type: "run.finished",
          at: "2026-11-27T00:00:00.000Z",
          data: { runId },
        },
      ],
      lastSeq: after + 1,
    }
  }

  async listPermissions(runId: string): Promise<PermissionRequestView[]> {
    return [
      {
        requestId: `perm-${runId}`,
        generation: 1,
        title: "Write file",
        kind: "edit",
        options: ["allow", "deny"],
        status: "resolved",
        decision: "allow",
        by: "policy",
        requestedAt: "2026-11-27T00:00:00.000Z",
        expiresAt: "2026-11-27T00:05:00.000Z",
      },
    ]
  }
}

describe("@agenticform/script", () => {
  test("validates syntax before execution", () => {
    expect(validateScript("return 1 + 2").ok).toBe(true)
    expect(validateScript("   ").ok).toBe(false)
    expect(validateScript("const x = {").ok).toBe(false)
  })

  test("executes host API calls and returns computed JSON", async () => {
    const port = new FakeRunsPort()
    const runtime = createScriptRuntime(port, { parentRunId: "parent-0" })
    const result = await runtime.execute(`
      const nodes = await af.listNodes()
      const ran = await af.run({ harness: "codex", prompt: "check build", idempotencyKey: "step-1" })
      const started = await af.startRun({ harness: "codex", prompt: "side task" })
      const fetched = await af.getRun(started.runId)
      const events = await af.listEvents(ran.runId, 0)
      const perms = await af.listPermissions(ran.runId)
      const cancelled = await af.cancelRun(started.runId)
      return {
        nodeCount: nodes.length,
        ranStatus: ran.status,
        ranResult: ran.result,
        fetchedId: fetched.runId,
        eventCount: events.events.length,
        permId: perms[0].requestId,
        cancelledStatus: cancelled.status,
      }
    `)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        nodeCount: 1,
        ranStatus: "completed",
        ranResult: { summary: "done:check build" },
        fetchedId: "run-2",
        eventCount: 1,
        permId: "perm-run-1",
        cancelledStatus: "cancelled",
      })
    }
    expect(port.createdRequests[0]?.parentRunId).toBe("parent-0")
    expect(port.createdRequests[0]?.idempotencyKey).toMatch(/:step-1$/)
  })

  test("confines scripts against ambient runtime and admin APIs", async () => {
    const port = new FakeRunsPort()
    const runtime = createScriptRuntime(port)
    for (const snippet of [
      "return typeof process === 'undefined' ? 'confined' : process.env",
      "return typeof fetch === 'undefined' ? 'confined' : fetch",
      "return typeof Bun === 'undefined' ? 'confined' : Bun.version",
      "return typeof af.answerPermission === 'undefined' ? 'confined' : 'exposed'",
      "return typeof af.issueToken === 'undefined' ? 'confined' : 'exposed'",
    ]) {
      const res = await runtime.execute(snippet)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toBe("confined")
    }

    const evalRes = await runtime.execute("return eval('1+1')")
    expect(evalRes.ok).toBe(false)

    const fsRes = await runtime.execute("const fs = require('node:fs'); return fs")
    expect(fsRes.ok).toBe(false)
  })

  test("suspends during durable af.run wait and resumes across fresh runtimes without re-creating the child run", async () => {
    const port = new FakeRunsPort()
    port.setAutoComplete(false)

    const waitingSignals: string[] = []
    const rt1 = createScriptRuntime(port, {
      pollIntervalMs: 10,
      onDurableWait: (runId) => waitingSignals.push(runId),
    })

    const program1 = rt1.program(
      `
        const first = await af.run({ harness: "codex", prompt: "part 1" })
        return { status: first.status, out: first.result }
      `,
      { runId: "wf-durable-1" },
    )

    const running = program1.run()
    while (waitingSignals.length === 0) {
      await Bun.sleep(5)
    }

    const suspended = await program1.suspend()
    await running
    expect(suspended.ok).toBe("suspended")
    if (suspended.ok !== "suspended") throw new Error("expected suspended outcome")
    expect(port.createdRequests).toHaveLength(1)

    // Resume in a completely fresh runtime instance from serialized bytes.
    port.completeRun("run-1", { ok: true, count: 42 })
    const rt2 = createScriptRuntime(port, { pollIntervalMs: 10 })
    const program2 = rt2.resume(suspended.bytes)
    const finished = await program2.run()

    expect(finished.ok).toBe(true)
    if (finished.ok === true) {
      expect(finished.value).toEqual({
        status: "completed",
        out: { ok: true, count: 42 },
      })
    }
    // Critical invariant: child run was created ONCE across suspend + resume.
    expect(port.createdRequests).toHaveLength(1)
  })

  test("aborting signal cancels in-flight durable child run", async () => {
    const port = new FakeRunsPort()
    port.setAutoComplete(false)
    let waitingId = ""
    const runtime = createScriptRuntime(port, {
      pollIntervalMs: 10,
      onDurableWait: (runId) => {
        waitingId = runId
      },
    })
    const controller = new AbortController()
    const running = runtime.execute(
      `return await af.run({ harness: "codex", prompt: "long task" })`,
      { signal: controller.signal },
    )
    while (!waitingId) {
      await Bun.sleep(5)
    }
    controller.abort("cancelled-by-test")
    await expect(running).rejects.toMatchObject({ name: "AbortError" })
    expect(port.cancelledIds).toContain("run-1")
  })

  test("enforces maxChildRuns across suspend/resume, timeoutMs, maxSnapshotBytes, and input validation", async () => {
    const port = new FakeRunsPort()
    port.setAutoComplete(false)
    let waited = false
    const rt1 = createScriptRuntime(port, {
      limits: { maxChildRuns: 1 },
      pollIntervalMs: 10,
      onDurableWait: () => {
        waited = true
      },
    })

    const p1 = rt1.program(`
      await af.run({ harness: "codex", prompt: "one" })
      await af.run({ harness: "codex", prompt: "two" })
      return "unreachable"
    `)
    const r1 = p1.run()
    while (!waited) await Bun.sleep(5)
    const susp = await p1.suspend()
    await r1
    expect(susp.ok).toBe("suspended")
    if (susp.ok !== "suspended") throw new Error("expected suspended")

    port.completeRun("run-1", "ok")
    const rt2 = createScriptRuntime(port, { limits: { maxChildRuns: 1 }, pollIntervalMs: 10 })
    const r2 = await rt2.resume(susp.bytes).run()
    expect(r2.ok).toBe(false)
    if (r2.ok === false) {
      expect(r2.error.kind).toBe("LimitExceeded")
    }

    // Timeout stops infinite loop.
    const fastTimeout = createScriptRuntime(port, { limits: { timeoutMs: 30 } })
    const timedOut = await fastTimeout.execute("while (true) {}")
    expect(timedOut.ok).toBe(false)
    if (!timedOut.ok) expect(timedOut.error.kind).toBe("TimeoutExceeded")

    // maxSnapshotBytes rejects oversized snapshot without killing run.
    port.setAutoComplete(false)
    let waitedSmall = false
    const tinySnapRt = createScriptRuntime(port, {
      limits: { maxSnapshotBytes: 10 },
      pollIntervalMs: 10,
      onDurableWait: () => {
        waitedSmall = true
      },
    })
    const pSmall = tinySnapRt.program(`return await af.run({ harness: "codex", prompt: "one" })`)
    const cSmall = new AbortController()
    const runSmall = pSmall.run({ signal: cSmall.signal })
    while (!waitedSmall) await Bun.sleep(5)
    await expect(pSmall.suspend()).rejects.toBeInstanceOf(SuspendError)
    cSmall.abort("cleanup")
    await expect(runSmall).rejects.toMatchObject({ name: "AbortError" })

    // Invalid af.run args fail closed.
    const badArgs = await fastTimeout.execute(
      `return await af.run({ harness: "codex", prompt: "p", parentRunId: "spoof" })`,
    )
    expect(badArgs.ok).toBe(false)
    if (!badArgs.ok) expect(badArgs.error.kind).toBe("InvalidInput")
  })
})
