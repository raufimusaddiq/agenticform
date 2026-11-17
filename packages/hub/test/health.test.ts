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
  return { node, runId: run.body.runId as string, command, offlineAt }
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
    const { runId, command } = await disconnectedRun()
    const replacement = await enroll(hub as Hub, { name: "replacement" })
    await heartbeat(hub as Hub, replacement)

    const recovered = await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)
    expect(recovered.status).toBe(200)
    expect(recovered.body.generation).toBe(2)
    expect(recovered.body.nodeId).toBe(replacement.nodeId)
    expect(recovered.body.status).toBe("queued")

    const queued = (hub as Hub).db
      .query<{ type: string; generation: number; status: string; node_id: string }, [string]>(
        "SELECT type, generation, status, node_id FROM commands WHERE run_id = ? AND generation = 2",
      )
      .get(runId)
    expect(queued).toEqual({ type: "run.start", generation: 2, status: "queued", node_id: replacement.nodeId })

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
    const { runId } = await disconnectedRun()
    const replacement = await enroll(hub as Hub, { name: "replacement" })
    await heartbeat(hub as Hub, replacement)
    await api(hub as Hub, "POST", `/v1/runs/${runId}/recover`)

    const command = (await nextCommand(hub as Hub, replacement)).body
    expect(command.runId).toBe(runId)
    expect(command.generation).toBe(2)
  })
})
