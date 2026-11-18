import { afterEach, describe, expect, test } from "bun:test"
import { commandFingerprint } from "@agenticform/protocol/canonical"
import type { Hub } from "../src/index.ts"
import { api, createRun, enroll, heartbeat, nextCommand, signedFetch, startHub } from "./helpers.ts"

let hub: Hub | undefined
afterEach(() => {
  hub?.stop()
  hub = undefined
})

const lease = async (node: Awaited<ReturnType<typeof enroll>>) => {
  const response = await nextCommand(hub as Hub, node)
  expect(response.status).toBe(200)
  return response.body
}

describe("placement", () => {
  test("no eligible node fails without queueing a command", async () => {
    hub = startHub()
    const response = await createRun(hub)
    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe("no_eligible_node")
    expect(hub.db.query("SELECT COUNT(*) AS n FROM commands").get()).toEqual({ n: 0 })
    expect(hub.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 })
  })

  test("a missing required capability is reported, never degraded", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node, { capabilities: ["git"] })
    const response = await createRun(hub, { requires: ["mcp.http"] })
    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe("capability_missing")
    expect(hub.db.query("SELECT COUNT(*) AS n FROM commands").get()).toEqual({ n: 0 })
  })

  test("a node without the harness is skipped", async () => {
    hub = startHub()
    const node = await enroll(hub, { harnesses: ["opencode"] })
    await heartbeat(hub, node, { harnesses: ["opencode"] })
    const response = await createRun(hub, { harness: "codex" })
    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe("no_eligible_node")
  })

  test("no_eligible_node names the harness and the best-known status", async () => {
    hub = startHub()
    const missing = await enroll(hub, { name: "missing", harnesses: [] })
    const auth = await enroll(hub, { name: "auth", harnesses: [] })
    await heartbeat(hub, missing, {
      harnesses: [],
      harnessReport: [{ id: "codex", status: "missing", reason: "not_installed" }],
    })
    await heartbeat(hub, auth, {
      harnesses: [],
      harnessReport: [{ id: "codex", status: "unauthenticated", reason: "auth_required" }],
    })
    const response = await createRun(hub, { harness: "codex" })
    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe("no_eligible_node")
    expect(response.body.error.message).toContain("codex")
    expect(response.body.error.message).toContain("unauthenticated")
    expect(response.body.error.message).toContain(auth.nodeId)
  })

  test("no_eligible_node stays plain when no node reported the harness", async () => {
    hub = startHub()
    const node = await enroll(hub, { harnesses: [] })
    await heartbeat(hub, node, { harnesses: [] })
    const response = await createRun(hub, { harness: "codex" })
    expect(response.status).toBe(422)
    expect(response.body.error.message).toBe("no node satisfies codex")
  })

  test("capacity reservations spread a burst across nodes", async () => {
    hub = startHub()
    const first = await enroll(hub, { name: "first" })
    const second = await enroll(hub, { name: "second" })
    await heartbeat(hub, first, { capacity: { slots: 1, inUse: 0 } })
    await heartbeat(hub, second, { capacity: { slots: 1, inUse: 0 } })

    const one = await createRun(hub)
    const two = await createRun(hub)
    expect(one.status).toBe(201)
    expect(two.status).toBe(201)
    expect(new Set([one.body.nodeId, two.body.nodeId]).size).toBe(2)

    const three = await createRun(hub)
    expect(three.status).toBe(422)
    expect(three.body.error.code).toBe("no_eligible_node")
  })

  test("least-loaded node wins", async () => {
    hub = startHub()
    const busy = await enroll(hub, { name: "busy" })
    const idle = await enroll(hub, { name: "idle" })
    await heartbeat(hub, busy, { capacity: { slots: 2, inUse: 0 } })
    await heartbeat(hub, idle, { capacity: { slots: 2, inUse: 0 } })

    const pinned = await createRun(hub, { nodeId: busy.nodeId })
    expect(pinned.status).toBe(201)
    const response = await createRun(hub)
    expect(response.status).toBe(201)
    expect(response.body.nodeId).toBe(idle.nodeId)
  })
})

describe("idempotency key", () => {
  test("same key and payload returns the same run; a different payload conflicts", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const first = await createRun(hub, { idempotencyKey: "job-42" })
    const second = await createRun(hub, { idempotencyKey: "job-42" })
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.runId).toBe(first.body.runId)
    expect(hub.db.query("SELECT COUNT(*) AS n FROM commands").get()).toEqual({ n: 1 })

    const conflict = await createRun(hub, { idempotencyKey: "job-42", prompt: "something else" })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe("idempotency_conflict")
  })
  test("run request field types are validated", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    for (const patch of [{ labels: { a: 1 } }, { mcpServers: "x" }, { gitBacked: "yes" }, { requires: [1] }]) {
      const response = await createRun(hub, patch)
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe("invalid_input")
    }
  })
})

describe("end to end through a fake node", () => {
  test("one command, ordered events, exactly one terminal event", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)

    const run = await createRun(hub, { requires: ["git"], mcpServers: [] })
    expect(run.status).toBe(201)
    expect(run.body.status).toBe("queued")

    const command = await lease(node)
    expect(command.type).toBe("run.start")
    expect(command.runId).toBe(run.body.runId)
    expect(command.generation).toBe(1)
    const { fingerprint, ...payload } = command.payload
    expect(fingerprint).toBe(
      commandFingerprint(command.type, command.idempotencyKey, command.generation, JSON.stringify(payload)),
    )

    const me = await api(hub, "GET", `/v1/runs/${run.body.runId}`)
    expect(me.body.status).toBe("leased")

    const batch = {
      leaseId: command.leaseId,
      events: [
        { key: "c1:1", type: "run.started", at: new Date().toISOString(), data: { harness: "codex" } },
        { key: "c1:2", type: "message.delta", at: new Date().toISOString(), data: { text: "ok" } },
      ],
    }
    const appended = await signedFetch(hub, node, "POST", `/v1/node/commands/${command.commandId}/events`, batch)
    expect(appended.status).toBe(200)
    expect(await appended.json()).toEqual({ accepted: 2, lastSeq: 2 })

    const duplicate = await signedFetch(hub, node, "POST", `/v1/node/commands/${command.commandId}/events`, batch)
    expect(await duplicate.json()).toEqual({ accepted: 0, lastSeq: 2 })

    const completed = await signedFetch(hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed", text: "ok" },
    })
    expect(completed.status).toBe(200)

    const events = await api(hub, "GET", `/v1/runs/${run.body.runId}/events?after=0`)
    expect(events.body.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3])
    expect(events.body.events.filter((event: { type: string }) => event.type === "run.finished")).toHaveLength(1)
    expect(events.body.events.at(-1).data.status).toBe("completed")

    const finished = await api(hub, "GET", `/v1/runs/${run.body.runId}`)
    expect(finished.body.status).toBe("completed")
    expect(finished.body.result.status).toBe("completed")
    expect(finished.body.lastSeq).toBe(3)

    const sse = await fetch(`${hub.url}/v1/runs/${run.body.runId}/events?stream=sse&after=1`, {
      headers: { authorization: `Bearer ${hub.config.adminToken}` },
    })
    const text = await sse.text()
    expect(text).toContain("id: 2")
    expect(text).toContain("id: 3")
    expect(text).not.toContain("id: 1")
    expect(text).toContain("run.finished")
  })

  test("a late consumer replays the full sequence", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    const command = await lease(node)
    await signedFetch(hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "failed",
      error: { code: "process_exited", message: "boom" },
    })
    const events = await api(hub, "GET", `/v1/runs/${run.body.runId}/events?after=0`)
    expect(events.body.events).toHaveLength(1)
    expect(events.body.events[0].type).toBe("run.finished")
    expect(events.body.events[0].data.status).toBe("failed")
    expect(events.body.lastSeq).toBe(1)
  })

  test("an unknown run's events return 404 without streaming", async () => {
    hub = startHub()
    const response = await api(hub, "GET", "/v1/runs/does-not-exist/events?after=0")
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe("not_found")
  })

  test("aborting an SSE stream mid-flight does not reject", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    const controller = new AbortController()
    const response = await fetch(`${hub.url}/v1/runs/${run.body.runId}/events?stream=sse`, {
      headers: { authorization: `Bearer ${hub.config.adminToken}` },
      signal: controller.signal,
    })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    await Bun.sleep(300)
    controller.abort()
    await Bun.sleep(300)
  })
})

describe("harness report validation", () => {
  test("an id longer than 64 characters is rejected", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const response = await heartbeat(hub, node, {
      harnessReport: [{ id: "x".repeat(65), status: "ready" }],
    })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe("invalid_input")
  })

  test("a reason longer than 128 characters is rejected", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const response = await heartbeat(hub, node, {
      harnessReport: [{ id: "codex", status: "unknown", reason: "x".repeat(129) }],
    })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe("invalid_input")
  })

  test("the caps are inclusive", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const response = await heartbeat(hub, node, {
      harnessReport: [{ id: "x".repeat(64), status: "unknown", reason: "x".repeat(128) }],
    })
    expect(response.status).toBe(200)
  })
})
