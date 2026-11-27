import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WorkflowView } from "@agenticform/protocol"
import { api, createRun, enroll, heartbeat, signedFetch, startHub, type TestNode } from "./helpers.ts"
import type { Hub } from "../src/index.ts"

async function waitForWorkflow(
  hub: Hub,
  workflowId: string,
  predicate: (view: WorkflowView) => boolean,
  timeoutMs = 5_000,
): Promise<WorkflowView> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await api(hub, "GET", `/v1/workflows/${workflowId}`)
    if (res.status === 200 && predicate(res.body as WorkflowView)) {
      return res.body as WorkflowView
    }
    await Bun.sleep(15)
  }
  throw new Error(`workflow ${workflowId} did not satisfy predicate within ${timeoutMs}ms`)
}

async function leaseAndCompleteNext(
  hub: Hub,
  node: TestNode,
  result: unknown,
): Promise<{ runId: string; commandId: string }> {
  const leaseRes = await signedFetch(hub, node, "GET", "/v1/node/commands/next")
  expect(leaseRes.status).toBe(200)
  const envelope = (await leaseRes.json()) as {
    commandId: string
    runId: string
    leaseId: string
  }
  const completeRes = await signedFetch(
    hub,
    node,
    "POST",
    `/v1/node/commands/${envelope.commandId}/complete`,
    {
      leaseId: envelope.leaseId,
      status: "succeeded",
      result,
    },
  )
  expect(completeRes.status).toBe(200)
  return { runId: envelope.runId, commandId: envelope.commandId }
}

describe("durable workflows", () => {
  test("creates, lists, and respects idempotency for /v1/workflows", async () => {
    const hub = startHub()
    try {
      const payload = {
        idempotencyKey: "wf-idem-1",
        code: "return { sum: x + y, nodes: (await af.listNodes()).length }",
        bindings: { x: 20, y: 22 },
      }
      const first = await api(hub, "POST", "/v1/workflows", payload)
      expect(first.status).toBe(201)
      const second = await api(hub, "POST", "/v1/workflows", payload)
      expect(second.status).toBe(200)
      expect(second.body.workflowId).toBe(first.body.workflowId)

      const conflict = await api(hub, "POST", "/v1/workflows", {
        ...payload,
        code: "return 99",
      })
      expect(conflict.status).toBe(409)
      expect(conflict.body.error.code).toBe("idempotency_conflict")

      const done = await waitForWorkflow(hub, first.body.workflowId, (w) => w.status === "completed")
      expect(done.result).toEqual({ sum: 42, nodes: 0 })

      const listed = await api(hub, "GET", "/v1/workflows")
      expect(listed.status).toBe(200)
      expect(listed.body.workflows.map((w: WorkflowView) => w.workflowId)).toContain(first.body.workflowId)
    } finally {
      hub.stop()
    }
  })

  test("rejects syntax errors and limit violations fail-closed", async () => {
    const hub = startHub({ workflowMaxCodeBytes: 64, workflowMaxChildRuns: 5 })
    try {
      const badSyntax = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-bad-1",
        code: "return {",
      })
      expect(badSyntax.status).toBe(400)
      expect(badSyntax.body.error.code).toBe("script_invalid")

      const tooLong = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-long-1",
        code: `return "${"a".repeat(100)}"`,
      })
      expect(tooLong.status).toBe(422)
      expect(tooLong.body.error.code).toBe("workflow_limit_exceeded")

      const overCap = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-cap-1",
        code: "return 1",
        limits: { maxChildRuns: 10 },
      })
      expect(overCap.status).toBe(422)
      expect(overCap.body.error.code).toBe("workflow_limit_exceeded")
    } finally {
      hub.stop()
    }
  })

  test("enforces parentRunId depth limits and propagates parentRunId to child runs", async () => {
    const hub = startHub({ maxDepth: 1 })
    try {
      const node = await enroll(hub)
      await heartbeat(hub, node, { capacity: { slots: 2, inUse: 0 } })

      const missingParent = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-parent-missing",
        code: "return 1",
        parentRunId: "no-such-run",
      })
      expect(missingParent.status).toBe(404)
      expect(missingParent.body.error.code).toBe("parent_not_found")

      const rootRun = await createRun(hub, { idempotencyKey: "root-run-1", nodeId: node.nodeId })
      expect(rootRun.status).toBe(201)

      const okWorkflow = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-depth-1",
        code: `const r = await af.startRun({ harness: "codex", prompt: "child" }); return r.parentRunId`,
        parentRunId: rootRun.body.runId,
      })
      expect(okWorkflow.status).toBe(201)
      expect(okWorkflow.body.depth).toBe(1)
      const done = await waitForWorkflow(hub, okWorkflow.body.workflowId, (w) => w.status === "completed")
      expect(done.result).toBe(rootRun.body.runId)
      expect(done.childRunIds).toHaveLength(1)

      const childRunId = done.childRunIds[0] as string
      const tooDeep = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-depth-2",
        code: "return 1",
        parentRunId: childRunId,
      })
      expect(tooDeep.status).toBe(422)
      expect(tooDeep.body.error.code).toBe("depth_exceeded")
    } finally {
      hub.stop()
    }
  })

  test("allows scoped runs caller tokens and blocks revoked tokens", async () => {
    const hub = startHub()
    try {
      const issued = await api(hub, "POST", "/v1/tokens", { name: "wf-caller", scope: "runs" })
      expect(issued.status).toBe(201)
      const callerToken = issued.body.token as string

      const created = await api(
        hub,
        "POST",
        "/v1/workflows",
        { idempotencyKey: "wf-token-1", code: "return 'ok'" },
        callerToken,
      )
      expect(created.status).toBe(201)
      await waitForWorkflow(hub, created.body.workflowId, (w) => w.status === "completed")

      const listed = await api(hub, "GET", "/v1/workflows", undefined, callerToken)
      expect(listed.status).toBe(200)

      await api(hub, "POST", `/v1/tokens/${issued.body.id}/revoke`)
      const revoked = await api(hub, "GET", "/v1/workflows", undefined, callerToken)
      expect(revoked.status).toBe(401)
    } finally {
      hub.stop()
    }
  })

  test("parks awaiting workflows to SQLite and resumes automatically across a hub restart", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "af-wf-restart-")), "hub.sqlite")
    const hub1 = startHub({ stateFile, workflowParkMs: 15 })
    let node: TestNode
    let workflowId = ""
    let childRunId = ""

    try {
      node = await enroll(hub1, { harnesses: ["codex"] })
      await heartbeat(hub1, node, { harnesses: ["codex"], capacity: { slots: 2, inUse: 0 } })

      const created = await api(hub1, "POST", "/v1/workflows", {
        idempotencyKey: "wf-restart-1",
        code: `
          const first = await af.run({ harness: "codex", prompt: "analyze" })
          return { status: first.status, output: first.result }
        `,
      })
      expect(created.status).toBe(201)
      workflowId = created.body.workflowId as string

      const parked = await waitForWorkflow(hub1, workflowId, (w) => w.status === "suspended")
      expect(parked.childRunIds).toHaveLength(1)
      childRunId = parked.childRunIds[0] as string

      const row = hub1.db
        .query<{ snapshot_bytes: Uint8Array | null }, [string]>(
          "SELECT snapshot_bytes FROM workflows WHERE id = ?",
        )
        .get(workflowId)
      expect(row?.snapshot_bytes).not.toBeNull()
      expect(row?.snapshot_bytes?.byteLength).toBeGreaterThan(0)

      await hub1.suspendWorkflows()
    } finally {
      hub1.stop()
    }

    // Restart a brand-new hub on the same SQLite database.
    const hub2 = startHub({ stateFile, workflowParkMs: 15 })
    try {
      const stillSuspended = await api(hub2, "GET", `/v1/workflows/${workflowId}`)
      expect(stillSuspended.status).toBe(200)
      expect(stillSuspended.body.status).toBe("suspended")

      const completed = await leaseAndCompleteNext(hub2, node!, { answer: "all green" })
      expect(completed.runId).toBe(childRunId)

      const finished = await waitForWorkflow(hub2, workflowId, (w) => w.status === "completed")
      expect(finished.result).toEqual({
        status: "completed",
        output: { answer: "all green" },
      })
      expect(finished.childRunIds).toEqual([childRunId])
    } finally {
      hub2.stop()
    }
  })

  test("cancelling a suspended workflow cancels its child run and clears snapshot bytes", async () => {
    const hub = startHub({ workflowParkMs: 15 })
    try {
      const node = await enroll(hub, { harnesses: ["codex"] })
      await heartbeat(hub, node, { harnesses: ["codex"] })

      const created = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-cancel-1",
        code: `return await af.run({ harness: "codex", prompt: "wait forever" })`,
      })
      const workflowId = created.body.workflowId as string
      const parked = await waitForWorkflow(hub, workflowId, (w) => w.status === "suspended")
      const childRunId = parked.childRunIds[0] as string

      const cancelled = await api(hub, "POST", `/v1/workflows/${workflowId}/cancel`)
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.status).toBe("cancelled")

      const childRun = await api(hub, "GET", `/v1/runs/${childRunId}`)
      expect(childRun.body.status).toBe("cancelled")

      const snap = hub.db
        .query<{ snapshot_bytes: Uint8Array | null }, [string]>(
          "SELECT snapshot_bytes FROM workflows WHERE id = ?",
        )
        .get(workflowId)
      expect(snap?.snapshot_bytes).toBeNull()
    } finally {
      hub.stop()
    }
  })

  test("fails closed on uncheckpointed running rows and corrupt snapshots at startup", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "af-wf-crash-")), "hub.sqlite")
    const hub1 = startHub({ stateFile })
    const now = Date.now()
    hub1.db
      .query(
        `INSERT INTO workflows
           (id, idempotency_key, request_json, code, bindings_json, limits_json, depth, status, snapshot_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '{}', 0, 'running', NULL, ?, ?)`,
      )
      .run("wf-uncheckpointed", "k-uncheck", "{}", "return 1", now, now)
    hub1.db
      .query(
        `INSERT INTO workflows
           (id, idempotency_key, request_json, code, bindings_json, limits_json, depth, status, snapshot_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '{"timeoutMs":1000,"maxOutputBytes":1024,"maxSnapshotBytes":1024,"maxChildRuns":1}', 0, 'suspended', ?, ?, ?)`,
      )
      .run("wf-corrupt", "k-corrupt", "{}", "return 1", new TextEncoder().encode("not-a-snapshot"), now, now)
    hub1.stop()

    const hub2 = startHub({ stateFile })
    try {
      const uncheck = await api(hub2, "GET", "/v1/workflows/wf-uncheckpointed")
      expect(uncheck.status).toBe(200)
      expect(uncheck.body.status).toBe("failed")
      expect(uncheck.body.error.kind).toBe("Interrupted")

      const corrupt = await waitForWorkflow(hub2, "wf-corrupt", (w) => w.status === "failed")
      expect(corrupt.error?.kind).toBe("SnapshotError")
    } finally {
      hub2.stop()
    }
  })

  test("cancelling an active workflow during an in-flight suspend marks it cancelled and stops its child run", async () => {
    const hub = startHub({ workflowParkMs: 10_000 })
    try {
      const node = await enroll(hub, { harnesses: ["codex"] })
      await heartbeat(hub, node, { harnesses: ["codex"], capacity: { slots: 2, inUse: 0 } })

      const first = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-cancel-active-1",
        code: `return await af.run({ harness: "codex", prompt: "long wait 1" })`,
      })
      const wf1 = first.body.workflowId as string
      const active1 = await waitForWorkflow(hub, wf1, (w) => w.childRunIds.length === 1)
      expect(active1.status).toBe("running")

      const cancelled1 = await api(hub, "POST", `/v1/workflows/${wf1}/cancel`)
      expect(cancelled1.status).toBe(200)
      expect(cancelled1.body.status).toBe("cancelled")
      expect(cancelled1.body.completedAt).not.toBeNull()
      expect((await api(hub, "GET", `/v1/runs/${active1.childRunIds[0]}`)).body.status).toBe("cancelled")

      // Race suspendWorkflows() directly against cancel on an active workflow.
      const second = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-cancel-race-2",
        code: `return await af.run({ harness: "codex", prompt: "long wait 2" })`,
      })
      const wf2 = second.body.workflowId as string
      const active2 = await waitForWorkflow(hub, wf2, (w) => w.childRunIds.length === 1)

      const [, cancelled2] = await Promise.all([
        hub.suspendWorkflows(),
        api(hub, "POST", `/v1/workflows/${wf2}/cancel`),
      ])
      expect(cancelled2.status).toBe(200)
      expect(cancelled2.body.status).toBe("cancelled")
      expect(cancelled2.body.completedAt).not.toBeNull()
      expect((await api(hub, "GET", `/v1/runs/${active2.childRunIds[0]}`)).body.status).toBe("cancelled")
      const snap = hub.db
        .query<{ snapshot_bytes: Uint8Array | null }, [string]>(
          "SELECT snapshot_bytes FROM workflows WHERE id = ?",
        )
        .get(wf2)
      expect(snap?.snapshot_bytes).toBeNull()
    } finally {
      hub.stop()
    }
  })

  test("concurrent POSTs with the same idempotencyKey replay cleanly without 500 errors", async () => {
    const hub = startHub()
    try {
      const payload = { idempotencyKey: "wf-concurrent-idem", code: "return 7 * 6" }
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => api(hub, "POST", "/v1/workflows", payload)),
      )
      for (const res of responses) {
        expect([200, 201]).toContain(res.status)
      }
      const ids = new Set(responses.map((res) => res.body.workflowId as string))
      expect(ids.size).toBe(1)

      const conflict = await api(hub, "POST", "/v1/workflows", {
        idempotencyKey: "wf-concurrent-idem",
        code: "return 1",
      })
      expect(conflict.status).toBe(409)
      expect(conflict.body.error.code).toBe("idempotency_conflict")
    } finally {
      hub.stop()
    }
  })
})
