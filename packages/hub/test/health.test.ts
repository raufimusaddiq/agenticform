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

describe("disable and revoke", () => {
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

    // Pending approval.
    ;(hub as Hub).db.query("UPDATE runs SET git_backed = 1, pending_approval = 1 WHERE id = ?").run(runId)
    const approval = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(approval.body.error.message).toContain("pending approval")

    // Node is not offline.
    ;(hub as Hub).db.query("UPDATE runs SET pending_approval = 0 WHERE id = ?").run(runId)
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

    // The old node cannot mutate the recovered run.
    const stale = await signedFetch(hub as Hub, replacement, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(stale.status).toBe(409)
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("queued")
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
