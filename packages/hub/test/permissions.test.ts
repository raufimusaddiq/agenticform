import { afterEach, describe, expect, test } from "bun:test"
import type { Hub } from "../src/index.ts"
import { recordRequested, recordResolved } from "../src/permissions.ts"
import { api, createRun, enroll, heartbeat, nextCommand, signedFetch, startHub } from "./helpers.ts"

let hub: Hub | undefined
afterEach(() => {
  hub?.stop()
  hub = undefined
})

const REQUEST = { toolCallId: "call_7", title: "Run `rm -rf build`", kind: "execute" }

interface Pending {
  hub: Hub
  node: Awaited<ReturnType<typeof enroll>>
  runId: string
  command: { commandId: string; leaseId: string }
}

/** An online node that advertises `permissions.remote`, one leased run.start. */
async function pendingRun(
  capabilities: string[] = ["permissions.remote"],
  permissionPolicy?: string,
): Promise<Pending> {
  const started = startHub()
  hub = started
  const node = await enroll(started)
  expect((await heartbeat(started, node, { capabilities })).status).toBe(200)
  const created = await createRun(started, { nodeId: node.nodeId, permissionPolicy: permissionPolicy ?? "ask" })
  expect(created.status).toBe(201)
  const command = (await nextCommand(started, node)).body
  return { hub: started, node, runId: created.body.runId as string, command }
}

async function requestPermission(
  pending: Pending,
  request: Record<string, unknown> = REQUEST,
): Promise<Response> {
  return signedFetch(pending.hub, pending.node, "POST", `/v1/node/commands/${pending.command.commandId}/events`, {
    leaseId: pending.command.leaseId,
    events: [
      {
        key: "c1:1",
        type: "permission.requested",
        at: new Date().toISOString(),
        data: { type: "permission.requested", turnId: "t1", request },
      },
    ],
  })
}

async function resolvePermission(pending: Pending, decision: string): Promise<Response> {
  return signedFetch(pending.hub, pending.node, "POST", `/v1/node/commands/${pending.command.commandId}/events`, {
    leaseId: pending.command.leaseId,
    events: [
      {
        key: "c1:2",
        type: "permission.resolved",
        at: new Date().toISOString(),
        data: { type: "permission.resolved", turnId: "t1", toolCallId: REQUEST.toolCallId, decision },
      },
    ],
  })
}

const list = (pending: Pending) => api(pending.hub, "GET", `/v1/runs/${pending.runId}/permissions`)
const answer = (pending: Pending, decision: unknown, token?: string) =>
  api(
    pending.hub,
    "POST",
    `/v1/runs/${pending.runId}/permissions/${REQUEST.toolCallId}`,
    { decision },
    token,
  )

describe("permission state machine (T016)", () => {
  test("requested is pending with the runtime's 300 s expiry", async () => {
    const pending = await pendingRun()
    expect((await requestPermission(pending)).status).toBe(200)
    const body = (await list(pending)).body
    expect(body.permissions).toHaveLength(1)
    const [view] = body.permissions
    expect(view).toMatchObject({
      requestId: "call_7",
      generation: 1,
      title: REQUEST.title,
      kind: "execute",
      options: ["allow", "deny"],
      status: "pending",
      decision: null,
    })
    expect(Date.parse(view.expiresAt) - Date.parse(view.requestedAt)).toBe(300_000)
  })

  test("an admin answer is answered, enqueues one command, then resolves", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    const answered = await answer(pending, "allow")
    expect(answered.status).toBe(200)
    expect(answered.body).toMatchObject({ status: "answered", decision: "allow" })

    const commands = pending.hub.db
      .query<{ type: string; payload_json: string }, [string]>(
        "SELECT type, payload_json FROM commands WHERE run_id = ? AND type = 'permission.answer'",
      )
      .all(pending.runId)
    expect(commands).toHaveLength(1)
    expect(JSON.parse(commands[0]?.payload_json as string)).toMatchObject({
      toolCallId: "call_7",
      decision: "allow",
      generation: 1,
    })

    expect((await resolvePermission(pending, "allow")).status).toBe(200)
    expect((await list(pending)).body.permissions[0]).toMatchObject({ status: "resolved", decision: "allow" })
  })

  test("an unanswered request is timed_out after expiry and resolved before it", async () => {
    const pending = await pendingRun()
    const now = Date.now()
    // A request that expired before the harness resolved it.
    recordRequested(pending.hub.db, pending.runId, 1, { request: { toolCallId: "old", title: null, kind: null } }, now - 400_000)
    recordResolved(pending.hub.db, pending.runId, 1, { toolCallId: "old", decision: "deny" }, now)
    // A request the harness cancelled before its expiry.
    recordRequested(pending.hub.db, pending.runId, 1, { request: { toolCallId: "fresh", title: null, kind: null } }, now)
    recordResolved(pending.hub.db, pending.runId, 1, { toolCallId: "fresh", decision: "cancelled" }, now)
    const rows = (await list(pending)).body.permissions as { requestId: string; status: string }[]
    expect(rows.find((row) => row.requestId === "old")?.status).toBe("timed_out")
    expect(rows.find((row) => row.requestId === "fresh")?.status).toBe("resolved")
  })

  test("nothing leaves a terminal state", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    await answer(pending, "deny")
    await resolvePermission(pending, "deny")
    // A late resolving event and a late answer both leave the row alone.
    await resolvePermission(pending, "allow")
    expect((await answer(pending, "allow")).status).toBe(409)
    expect((await list(pending)).body.permissions[0]).toMatchObject({ status: "resolved", decision: "deny" })
  })
})

describe("permission refusals (T017)", () => {
  test("a runs token may read but not answer", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    const issued = await api(pending.hub, "POST", "/v1/tokens", { name: "ci", scope: "runs" })
    const token = issued.body.token as string
    expect((await api(pending.hub, "GET", `/v1/runs/${pending.runId}/permissions`, undefined, token)).status).toBe(200)
    const refused = await answer(pending, "allow", token)
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe("forbidden")
  })

  test("a bad decision is invalid_input", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    const refused = await answer(pending, "maybe")
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe("invalid_input")
  })

  test("a second answer is permission_resolved", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    expect((await answer(pending, "allow")).status).toBe(200)
    const second = await answer(pending, "deny")
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe("permission_resolved")
  })

  test("an answer after expiry is permission_expired", async () => {
    const pending = await pendingRun()
    recordRequested(
      pending.hub.db,
      pending.runId,
      1,
      { request: { toolCallId: REQUEST.toolCallId, title: null, kind: null } },
      Date.now() - 400_000,
    )
    const refused = await answer(pending, "allow")
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("permission_expired")
  })

  test("a node without permissions.remote is permission_unsupported", async () => {
    const pending = await pendingRun([])
    await requestPermission(pending)
    const refused = await answer(pending, "allow")
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("permission_unsupported")
  })

  test("an answer for an old generation is not_found", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    pending.hub.db.query("UPDATE runs SET generation = 2 WHERE id = ?").run(pending.runId)
    const refused = await answer(pending, "allow")
    expect(refused.status).toBe(404)
    expect(refused.body.error.code).toBe("not_found")
  })
})

describe("concurrent answers (T018)", () => {
  test("exactly one 200 and exactly one command", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    const results = await Promise.all([answer(pending, "allow"), answer(pending, "deny")])
    expect(results.filter((result) => result.status === 200)).toHaveLength(1)
    expect(results.filter((result) => result.body.error?.code === "permission_resolved")).toHaveLength(1)
    const count = pending.hub.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM commands WHERE run_id = ? AND type = 'permission.answer'",
      )
      .get(pending.runId)
    expect(count?.n).toBe(1)
  })
})

describe("run end cancels open requests (T019)", () => {
  const status = (pending: Pending) =>
    pending.hub.db
      .query<{ status: string }, [string, string]>(
        "SELECT status FROM permission_requests WHERE run_id = ? AND tool_call_id = ?",
      )
      .get(pending.runId, REQUEST.toolCallId)?.status

  test("a failed run cancels a pending request", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    const completed = await signedFetch(
      pending.hub,
      pending.node,
      "POST",
      `/v1/node/commands/${pending.command.commandId}/complete`,
      { leaseId: pending.command.leaseId, status: "failed", error: { code: "agent_error", message: "boom" } },
    )
    expect(completed.status).toBe(200)
    expect(status(pending)).toBe("cancelled")
  })

  test("a cancel fences the generation and cancels an answered request", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    await answer(pending, "allow")
    const cancelled = await api(pending.hub, "POST", `/v1/runs/${pending.runId}/cancel`)
    expect(cancelled.status).toBe(202)
    expect(status(pending)).toBe("cancelled")
  })

  test("a disconnect cancels a pending request", async () => {
    const pending = await pendingRun()
    await requestPermission(pending)
    const disabled = await api(pending.hub, "POST", `/v1/nodes/${pending.node.nodeId}/disable`)
    expect(disabled.status).toBe(200)
    expect(status(pending)).toBe("cancelled")
  })
})

describe("event bounds (T020)", () => {
  test("a long title or kind is truncated, not refused", async () => {
    const pending = await pendingRun()
    const longTitle = "t".repeat(300)
    const longKind = "k".repeat(80)
    const response = await requestPermission(pending, { toolCallId: "call_7", title: longTitle, kind: longKind })
    expect(response.status).toBe(200)
    const [view] = (await list(pending)).body.permissions
    expect(view.title).toHaveLength(256)
    expect(view.kind).toHaveLength(64)
    // The stored event is bounded too, so a reader never sees the long value.
    const stored = pending.hub.db
      .query<{ data_json: string }, [string]>(
        "SELECT data_json FROM run_events WHERE run_id = ? AND type = 'permission.requested'",
      )
      .get(pending.runId)
    const data = JSON.parse(stored?.data_json as string) as { request: { title: string; kind: string } }
    expect(data.request.title).toHaveLength(256)
    expect(data.request.kind).toHaveLength(64)
  })

  test("a toolCallId over 128 chars is accepted but not recorded", async () => {
    const pending = await pendingRun()
    const response = await requestPermission(pending, {
      toolCallId: "x".repeat(129),
      title: "Write file",
      kind: "edit",
    })
    expect(response.status).toBe(200)
    expect((await list(pending)).body.permissions).toHaveLength(0)
    // The event itself is kept, so the run's stream is not stalled.
    const count = pending.hub.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'permission.requested'",
      )
      .get(pending.runId)
    expect(count?.n).toBe(1)
  })
})

describe("permission policy", () => {
  for (const [policy, decision] of [
    ["allow", "allow"],
    ["deny", "deny"],
  ] as const) {
    test(`policy ${policy} records a resolved row decided by policy and takes no remote answer`, async () => {
      const pending = await pendingRun(["permissions.remote"], policy)
      expect((await requestPermission(pending)).status).toBe(200)
      const [view] = (await list(pending)).body.permissions
      expect(view).toMatchObject({ requestId: "call_7", status: "resolved", decision, by: "policy" })
      expect((await resolvePermission(pending, decision)).status).toBe(200)
      expect((await list(pending)).body.permissions[0]).toMatchObject({ status: "resolved", decision, by: "policy" })

      const refused = await answer(pending, "allow")
      expect(refused.status).toBe(409)
      expect(refused.body.error.code).toBe("permission_resolved")
    })
  }

  test("the default policy is allow, and a missing request is still refused as policy-answered", async () => {
    const pending = await pendingRun(["permissions.remote"], "allow")
    const refused = await answer(pending, "deny")
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("permission_resolved")
  })

  test("the resolved event is the truth when the driver denied an allow", async () => {
    const pending = await pendingRun(["permissions.remote"], "allow")
    await requestPermission(pending)
    await resolvePermission(pending, "deny")
    expect((await list(pending)).body.permissions[0]).toMatchObject({ decision: "deny", by: "policy" })
  })

  test("policy ask keeps the pending flow and records an admin answer", async () => {
    const pending = await pendingRun(["permissions.remote"], "ask")
    await requestPermission(pending)
    expect((await list(pending)).body.permissions[0]).toMatchObject({ status: "pending", by: null })
    expect((await answer(pending, "allow")).body).toMatchObject({ status: "answered", decision: "allow", by: "admin" })
  })

  test("the policy is carried in the run.start payload", async () => {
    const pending = await pendingRun(["permissions.remote"], "deny")
    expect((pending.command as { payload?: unknown }).payload).toMatchObject({ permissionPolicy: "deny" })
  })

  test("a run with no policy is started as allow", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node, { capabilities: ["permissions.remote"] })
    expect((await createRun(hub, { nodeId: node.nodeId })).status).toBe(201)
    expect((await nextCommand(hub, node)).body.payload).toMatchObject({ permissionPolicy: "allow" })
  })
})
