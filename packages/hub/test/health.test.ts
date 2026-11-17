import { afterEach, describe, expect, test } from "bun:test"
import { sweepHealth, type Hub } from "../src/index.ts"
import { api, createRun, enroll, heartbeat, nextCommand, signedFetch, startHub } from "./helpers.ts"

let hub: Hub | undefined
afterEach(() => {
  hub?.stop()
  hub = undefined
})

const disconnectedRun = async () => {
  hub = startHub({ nodeOfflineMs: 45_000, recoveryGraceMs: 120_000 })
  const node = await enroll(hub)
  await heartbeat(hub, node)
  const run = await createRun(hub)
  const command = (await nextCommand(hub, node)).body
  const offlineAt = Date.now() + 60_000
  sweepHealth(hub.db, hub.config, offlineAt)
  hub.db.query("UPDATE runs SET disconnected_at = ? WHERE id = ?").run(Date.now() - 120_001, run.body.runId)
  const disconnected = hub.db
    .query<{ generation: number }, [string]>("SELECT generation FROM runs WHERE id = ?")
    .get(run.body.runId)
  return {
    node,
    runId: run.body.runId as string,
    command,
    offlineAt,
    generation: disconnected?.generation ?? 0,
  }
}

describe("node loss", () => {
  test("the heartbeat window marks the node OFFLINE and disconnects its runs", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    await nextCommand(hub, node)

    sweepHealth(hub.db, hub.config, Date.now() + 46_000)
    const nodeRow = hub.db.query<{ status: string }, [string]>("SELECT status FROM nodes WHERE id = ?").get(node.nodeId)
    expect(nodeRow?.status).toBe("offline")
    const runRow = hub.db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(run.body.runId)
    expect(runRow?.status).toBe("disconnected")

    const events = await api(hub, "GET", `/v1/runs/${run.body.runId}/events?after=0`)
    expect(events.body.events.map((event: { type: string }) => event.type)).toEqual(["run.disconnected"])
  })

  test("a live node is not swept", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    expect(sweepHealth(hub.db, hub.config, Date.now())).toBe(0)
    const nodeRow = hub.db.query<{ status: string }, [string]>("SELECT status FROM nodes WHERE id = ?").get(node.nodeId)
    expect(nodeRow?.status).toBe("online")
  })
})

describe("capacity ledger", () => {
  test("stale and oversized node reports cannot wedge the node", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node, { capacity: { slots: 2, inUse: 0 } })
    const first = await createRun(hub)
    expect(first.status).toBe(201)

    await heartbeat(hub, node, { capacity: { slots: 2, inUse: 0 } })
    await heartbeat(hub, node, { capacity: { slots: 2, inUse: 99 } })
    const row = hub.db
      .query<{ capacity_in_use: number }, [string]>("SELECT capacity_in_use FROM nodes WHERE id = ?")
      .get(node.nodeId)
    expect(row?.capacity_in_use).toBe(1)

    const second = await createRun(hub)
    expect(second.status).toBe(201)
  })
})

describe("disable and revoke", () => {
  test("a revoked node is terminal", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const revoked = await api(hub, "POST", `/v1/nodes/${node.nodeId}/revoke`)
    expect(revoked.status).toBe(200)
    const disable = await api(hub, "POST", `/v1/nodes/${node.nodeId}/disable`)
    expect(disable.status).toBe(403)
    expect(disable.body.error.code).toBe("forbidden")
    const again = await api(hub, "POST", `/v1/nodes/${node.nodeId}/revoke`)
    expect(again.status).toBe(200)
    expect(again.body.status).toBe("revoked")
  })

  for (const action of ["disable", "revoke"] as const) {
    test(`${action} disconnects and fences active runs`, async () => {
      hub = startHub()
      const node = await enroll(hub)
      await heartbeat(hub, node)
      const run = await createRun(hub)
      const command = (await nextCommand(hub, node)).body

      const response = await api(hub, "POST", `/v1/nodes/${node.nodeId}/${action}`)
      expect(response.status).toBe(200)
      expect(response.body.status).toBe(action === "disable" ? "disabled" : "revoked")

      const runRow = hub.db
        .query<{ status: string; generation: number }, [string]>("SELECT status, generation FROM runs WHERE id = ?")
        .get(run.body.runId)
      expect(runRow).toEqual({ status: "disconnected", generation: 2 })

      const commandRow = hub.db
        .query<{ status: string }, [string]>("SELECT status FROM commands WHERE id = ?")
        .get(command.commandId)
      expect(commandRow?.status).toBe("cancelled")

      const events = await api(hub, "GET", `/v1/runs/${run.body.runId}/events?after=0`)
      const last = events.body.events.at(-1)
      expect(last.type).toBe("run.disconnected")
      expect(last.data.reason).toBe(action === "disable" ? "node_disabled" : "node_revoked")
      expect(last.data.generation).toBe(2)
    })
  }
  test("a disconnected run cancels at the hub without the node", async () => {
    const { node, runId, command, generation } = await disconnectedRun()
    // Simulate the node reconnecting: cancel must still finish locally.
    hub?.db.query("UPDATE nodes SET status = 'online' WHERE id = ?").run(node.nodeId)
    const response = await api(hub as Hub, "POST", `/v1/runs/${runId}/cancel`)
    expect(response.status).toBe(200)
    expect(response.body.status).toBe("cancelled")
    const runRow = (hub as Hub).db
      .query<{ status: string; generation: number }, [string]>("SELECT status, generation FROM runs WHERE id = ?")
      .get(runId)
    expect(runRow).toEqual({ status: "cancelled", generation: generation + 1 })

    const events = await api(hub as Hub, "GET", `/v1/runs/${runId}/events?after=0`)
    expect(events.body.events.at(-1).data.status).toBe("cancelled")

    const stale = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(stale.status).toBe(409)
    const still = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(still?.status).toBe("cancelled")
  })

  test("inventory writes stay on the authenticated node's own run", async () => {
    hub = startHub()
    const owner = await enroll(hub, { name: "owner" })
    const other = await enroll(hub, { name: "other" })
    await heartbeat(hub, owner)
    await heartbeat(hub, other)
    const run = await createRun(hub, { nodeId: owner.nodeId })
    const command = (await nextCommand(hub, owner)).body

    const entry = (generation: number, session: string) => ({
      runId: run.body.runId,
      generation,
      runtimeType: "codex",
      runtimeSessionId: session,
      state: "running",
    })

    await heartbeat(hub, other, { runtimes: [entry(1, "stolen")] })
    await heartbeat(hub, other, { runtimes: [entry(2, "future")] })
    let assignment = hub.db
      .query<{ node_id: string; runtime_session_id: string | null }, [string]>(
        "SELECT node_id, runtime_session_id FROM runtime_assignments WHERE run_id = ? AND generation = 1",
      )
      .get(run.body.runId)
    expect(assignment).toEqual({ node_id: owner.nodeId, runtime_session_id: null })
    let stale = hub.db
      .query<{ stale_observations: number }, [string]>("SELECT stale_observations FROM nodes WHERE id = ?")
      .get(other.nodeId)
    expect(stale?.stale_observations).toBe(2)

    await heartbeat(hub, owner, { runtimes: [entry(1, "own")] })
    assignment = hub.db
      .query<{ node_id: string; runtime_session_id: string | null }, [string]>(
        "SELECT node_id, runtime_session_id FROM runtime_assignments WHERE run_id = ? AND generation = 1",
      )
      .get(run.body.runId)
    expect(assignment).toEqual({ node_id: owner.nodeId, runtime_session_id: "own" })
    void command
  })
})

describe("explicit recovery", () => {
  test("each missing precondition is named", async () => {
    const { runId, node } = await disconnectedRun()

    // Run is disconnected and preconditions hold except the replacement node.
    const noNode = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(noNode.status).toBe(422)
    expect(noNode.body.error.code).toBe("recovery_precondition_failed")
    expect(noNode.body.error.message).toContain("no eligible replacement node")

    // Not disconnected.
    ;(hub as Hub).db.query("UPDATE runs SET status = 'queued' WHERE id = ?").run(runId)
    const notDisconnected = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(notDisconnected.body.error.message).toContain("not disconnected")

    // Grace has not elapsed.
    ;(hub as Hub).db.query("UPDATE runs SET status = 'disconnected', disconnected_at = ? WHERE id = ?").run(Date.now(), runId)
    const grace = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(grace.body.error.message).toContain("grace period")

    // Not GIT-backed.
    ;(hub as Hub).db.query("UPDATE runs SET git_backed = 0, disconnected_at = ? WHERE id = ?").run(Date.now() - 200_000, runId)
    const notGit = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(notGit.body.error.message).toContain("GIT-backed")

    // Node is not offline.
    ;(hub as Hub).db.query("UPDATE runs SET git_backed = 1 WHERE id = ?").run(runId)
    ;(hub as Hub).db.query("UPDATE nodes SET status = 'online' WHERE id = ?").run(node.nodeId)
    const online = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(online.body.error.message).toContain("not offline")
  })

  test("recovery issues generation N+1 on a new node and does not dispatch before it exists", async () => {
    const { runId, command, generation } = await disconnectedRun()
    const replacement = await enroll(hub as Hub, { name: "replacement" })
    await heartbeat(hub as Hub, replacement)

    const recovered = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(recovered.status).toBe(200)
    expect(recovered.body.generation).toBe(generation + 1)
    expect(recovered.body.nodeId).toBe(replacement.nodeId)
    expect(recovered.body.status).toBe("queued")

    const queued = (hub as Hub).db
      .query<{ type: string; generation: number; status: string; node_id: string }, [string, number]>(
        "SELECT type, generation, status, node_id FROM commands WHERE run_id = ? AND generation = ?",
      )
      .get(runId, generation + 1)
    expect(queued).toEqual({
      type: "run.start",
      generation: generation + 1,
      status: "queued",
      node_id: replacement.nodeId,
    })
    const refreshed = (hub as Hub).db
      .query<{ cwd: string; workspace_id: string }, [string]>("SELECT cwd, workspace_id FROM runs WHERE id = ?")
      .get(runId)
    expect(refreshed?.cwd).toBe(refreshed?.workspace_id)
    const started = (hub as Hub).db
      .query<{ payload_json: string }, [string, number]>(
        "SELECT payload_json FROM commands WHERE run_id = ? AND generation = ?",
      )
      .get(runId, generation + 1)
    const payload = JSON.parse(started?.payload_json ?? "{}") as { cwd?: string }
    expect(payload.cwd).toBe(refreshed?.workspace_id)

    // The old node cannot mutate the recovered run.
    const stale = await signedFetch(hub as Hub, replacement, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(stale.status).toBe(409)
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("queued")
  })

  test("SSE replay crosses a recovery and keeps generation-scoped node keys", async () => {
    hub = startHub({ nodeOfflineMs: 45_000, recoveryGraceMs: 120_000 })
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    const runId = run.body.runId as string
    const first = (await nextCommand(hub, node)).body
    const before = await signedFetch(hub, node, "POST", `/v1/node/commands/${first.commandId}/events`, {
      leaseId: first.leaseId,
      events: [{ key: "c1:1", type: "message.delta", at: new Date().toISOString(), data: { text: "gen1" } }],
    })
    expect(before.status).toBe(200)
    sweepHealth(hub.db, hub.config, Date.now() + 46_000)
    hub.db.query("UPDATE runs SET disconnected_at = ? WHERE id = ?").run(Date.now() - 120_001, runId)

    const replacement = await enroll(hub, { name: "replacement" })
    await heartbeat(hub, replacement)
    const recovered = await api(hub, "POST", `/v1/runs/${runId}/recover`)
    expect(recovered.status).toBe(200)

    const command = (await nextCommand(hub, replacement)).body
    const after = await signedFetch(hub, replacement, "POST", `/v1/node/commands/${command.commandId}/events`, {
      leaseId: command.leaseId,
      events: [{ key: "c1:1", type: "message.delta", at: new Date().toISOString(), data: { text: "gen2" } }],
    })
    expect(after.status).toBe(200)
    const completed = await signedFetch(hub, replacement, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed" },
      eventsToSeq: 3,
    })
    expect(completed.status).toBe(200)

    const replayed = await api(hub, "GET", `/v1/runs/${runId}/events?after=0`)
    const sameKey = replayed.body.events.filter((event: { key: string }) => event.key.endsWith("c1:1"))
    expect(sameKey).toHaveLength(2)
    expect(new Set(sameKey.map((event: { seq: number }) => event.seq)).size).toBe(2)
    expect(sameKey.map((event: { data: { text: string } }) => event.data.text)).toEqual(["gen1", "gen2"])

    const response = await fetch(`${hub.url}/v1/runs/${runId}/events?stream=sse&after=0`, {
      headers: { authorization: `Bearer ${hub.config.adminToken}` },
    })
    const text = await response.text()
    expect(text).toContain("run.disconnected")
    expect(text).toContain("run.finished")
    expect(text.indexOf("run.disconnected")).toBeLessThan(text.indexOf("run.finished"))
    expect(text.match(/message\.delta/g)?.length).toBe(2)
  })

  test("a recovered run that disconnects again keeps both disconnected events", async () => {
    const { runId } = await disconnectedRun()
    const replacement = await enroll(hub as Hub, { name: "replacement" })
    await heartbeat(hub as Hub, replacement)
    const recovered = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(recovered.status).toBe(200)

    sweepHealth((hub as Hub).db, (hub as Hub).config, Date.now() + 46_000)
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("disconnected")

    const events = await api(hub as Hub, "GET", `/v1/runs/${runId}/events?after=0`)
    const disconnected = events.body.events.filter((event: { type: string }) => event.type === "run.disconnected")
    expect(disconnected).toHaveLength(2)
    expect(new Set(disconnected.map((event: { seq: number }) => event.seq)).size).toBe(2)
    expect(disconnected.map((event: { data: { generation: number } }) => event.data.generation)).toEqual([
      recovered.body.generation - 1,
      recovered.body.generation + 1,
    ])
  })

  test("the replacement node leases the new generation", async () => {
    const { runId, generation } = await disconnectedRun()
    const replacement = await enroll(hub as Hub, { name: "replacement" })
    await heartbeat(hub as Hub, replacement)
    await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)

    const command = (await nextCommand(hub as Hub, replacement)).body
    expect(command.runId).toBe(runId)
    expect(command.generation).toBe(generation + 1)
  })
})
