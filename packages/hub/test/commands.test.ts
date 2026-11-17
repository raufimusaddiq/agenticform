import { afterEach, describe, expect, test } from "bun:test"
import { sweepHealth, type Hub } from "../src/index.ts"
import { api, createRun, enroll, errorCode, heartbeat, nextCommand, signedFetch, startHub } from "./helpers.ts"

let hub: Hub | undefined
afterEach(() => {
  hub?.stop()
  hub = undefined
})

const setup = async () => {
  hub = startHub()
  const node = await enroll(hub)
  await heartbeat(hub, node)
  const run = await createRun(hub)
  const command = (await nextCommand(hub, node)).body
  return { node, runId: run.body.runId as string, command }
}

describe("fencing", () => {
  test("advancing the generation before lease cancels the command", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    hub.db.query("UPDATE runs SET generation = 2 WHERE id = ?").run(run.body.runId)

    const polled = await nextCommand(hub, node)
    expect(polled.status).toBe(204)
    const command = hub.db
      .query<{ status: string }, [string]>("SELECT status FROM commands WHERE run_id = ?")
      .get(run.body.runId)
    expect(command?.status).toBe("cancelled")
  })

  test("a stale completion is refused with no state change", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    const command = (await nextCommand(hub, node)).body

    hub.db.query("UPDATE runs SET generation = 2 WHERE id = ?").run(run.body.runId)
    const response = await signedFetch(hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe("fence_stale")

    const stored = hub.db
      .query<{ status: string; result_json: string | null }, [string]>("SELECT status, result_json FROM commands WHERE id = ?")
      .get(command.commandId)
    expect(stored).toEqual({ status: "cancelled", result_json: null })
    const runRow = hub.db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(run.body.runId)
    expect(runRow?.status).toBe("leased")
  })

  test("a stale heartbeat observation is recorded, not applied", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    await nextCommand(hub, node)
    hub.db.query("UPDATE runs SET generation = 2 WHERE id = ?").run(run.body.runId)

    await heartbeat(hub, node, {
      runtimes: [
        { runId: run.body.runId, generation: 1, runtimeType: "codex", runtimeSessionId: "old", state: "running" },
      ],
    })
    const row = hub.db.query<{ stale_observations: number }, [string]>("SELECT stale_observations FROM nodes WHERE id = ?").get(node.nodeId)
    expect(row?.stale_observations).toBe(1)
    const assignment = hub.db
      .query<{ runtime_session_id: string }, [string]>("SELECT runtime_session_id FROM runtime_assignments WHERE run_id = ? AND generation = 1")
      .get(run.body.runId)
    expect(assignment?.runtime_session_id).toBeNull()
  })
})

describe("terminal status mapping", () => {
  test("a node-reported cancellation ends the run as cancelled", async () => {
    const { node, runId, command } = await setup()
    const response = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "failed",
      error: { code: "cancelled", message: "agent cancelled" },
    })
    expect(response.status).toBe(200)
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("cancelled")
    const events = await api(hub as Hub, "GET", `/v1/runs/${runId}/events?after=0`)
    expect(events.body.events.at(-1).data.status).toBe("cancelled")
  })

  test("a succeeded result that reports cancellation ends the run as cancelled", async () => {
    const { node, runId, command } = await setup()
    await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "cancelled", text: "" },
    })
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("cancelled")
  })

  test("a completed run.cancel command cancels the run", async () => {
    const { node, runId } = await setup()
    const queued = await api(hub as Hub, "POST", `/v1/runs/${runId}/cancel`)
    expect(queued.status).toBe(202)
    const cancelCommand = (await nextCommand(hub as Hub, node)).body
    expect(cancelCommand.type).toBe("run.cancel")
    await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${cancelCommand.commandId}/complete`, {
      leaseId: cancelCommand.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("cancelled")
  })

  test("run.inspect never changes run status", async () => {
    const { node, runId } = await setup()
    const now = Date.now()
    ;(hub as Hub).db
      .query(
        `INSERT INTO commands (id, run_id, node_id, type, idempotency_key, generation, payload_json, fingerprint, status, lease_id, leased_until, created_at, updated_at)
         VALUES ('inspect-1', ?, ?, 'run.inspect', 'inspect', 1, '{}', 'sha256:x', 'leased', 'lease-1', ?, ?, ?)`,
      )
      .run(runId, node.nodeId, now + 60_000, now, now)
    const response = await signedFetch(hub as Hub, node, "POST", "/v1/node/commands/inspect-1/complete", {
      leaseId: "lease-1",
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(response.status).toBe(200)
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("leased")
    const terminal = (hub as Hub).db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run.finished'")
      .get(runId)
    expect(terminal).toEqual({ n: 0 })
  })
})

describe("leases", () => {
  test("renew extends a held lease and refuses an expired one", async () => {
    const { node, command } = await setup()
    const renewed = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/renew`, {})
    expect(renewed.status).toBe(200)
    expect(typeof ((await renewed.json()) as { leasedUntil: string }).leasedUntil).toBe("string")

    ;(hub as Hub).db.query("UPDATE commands SET leased_until = ? WHERE id = ?").run(Date.now() - 1, command.commandId)
    const expired = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/renew`, {})
    expect(expired.status).toBe(409)
    expect(await errorCode(expired)).toBe("lease_not_held")
  })

  test("an expired lease returns the command to the queue and can be re-leased", async () => {
    const { node, command } = await setup()
    ;(hub as Hub).db.query("UPDATE commands SET leased_until = ? WHERE id = ?").run(Date.now() - 1, command.commandId)
    const again = await nextCommand(hub as Hub, node)
    expect(again.status).toBe(200)
    expect(again.body.commandId).toBe(command.commandId)
    const completed = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${again.body.commandId}/complete`, {
      leaseId: again.body.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(completed.status).toBe(200)
  })

  test("an earlier lease cannot complete a re-leased command", async () => {
    const { node, command } = await setup()
    ;(hub as Hub).db.query("UPDATE commands SET leased_until = ? WHERE id = ?").run(Date.now() - 1, command.commandId)
    const again = await nextCommand(hub as Hub, node)
    expect(again.status).toBe(200)
    expect(again.body.leaseId).not.toBe(command.leaseId)

    const stale = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(stale.status).toBe(409)
    expect(await errorCode(stale)).toBe("lease_not_held")

    const fresh = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: again.body.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(fresh.status).toBe(200)
  })

  test("an earlier lease cannot append events to a re-leased command", async () => {
    const { node, command } = await setup()
    ;(hub as Hub).db.query("UPDATE commands SET leased_until = ? WHERE id = ?").run(Date.now() - 1, command.commandId)
    const again = await nextCommand(hub as Hub, node)
    expect(again.status).toBe(200)

    const stale = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/events`, {
      leaseId: command.leaseId,
      events: [{ key: "c1:1", type: "message.delta", at: new Date().toISOString(), data: {} }],
    })
    expect(stale.status).toBe(409)
    expect(await errorCode(stale)).toBe("fence_stale")

    const fresh = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/events`, {
      leaseId: again.body.leaseId,
      events: [{ key: "c1:1", type: "message.delta", at: new Date().toISOString(), data: {} }],
    })
    expect(fresh.status).toBe(200)
  })

  test("a completion for a non-leased command is refused", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    const commandId = hub.db
      .query<{ id: string }, [string]>("SELECT id FROM commands WHERE run_id = ?")
      .get(run.body.runId)?.id
    const response = await signedFetch(hub, node, "POST", `/v1/node/commands/${commandId}/complete`, {
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe("lease_not_held")
  })
})

describe("completion idempotency", () => {
  test("identical completion is a no-op and a conflicting one is rejected", async () => {
    const { node, command } = await setup()
    const body = { leaseId: command.leaseId, status: "succeeded", result: { status: "completed", text: "ok" } }
    const first = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, body)
    expect(first.status).toBe(200)
    const again = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, body)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(await first.clone().json())

    const conflict = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "failed",
      error: { code: "boom", message: "different" },
    })
    expect(conflict.status).toBe(409)
    expect(await errorCode(conflict)).toBe("idempotency_conflict")
  })

  test("a completion after the run is cancelled is refused", async () => {
    const { node, runId, command } = await setup()
    ;(hub as Hub).db.query("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(runId)
    const response = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe("fence_stale")
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("cancelled")
    const commandRow = (hub as Hub).db
      .query<{ status: string }, [string]>("SELECT status FROM commands WHERE id = ?")
      .get(command.commandId)
    expect(commandRow?.status).toBe("leased")
  })

  test("an expired lease cannot complete", async () => {
    const { node, runId, command } = await setup()
    ;(hub as Hub).db.query("UPDATE commands SET leased_until = ? WHERE id = ?").run(Date.now() - 1, command.commandId)
    const response = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe("lease_not_held")
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("leased")
    const commandRow = (hub as Hub).db
      .query<{ status: string }, [string]>("SELECT status FROM commands WHERE id = ?")
      .get(command.commandId)
    expect(commandRow?.status).toBe("leased")
  })

  test("completion is refused while eventsToSeq is ahead of stored events", async () => {
    const { node, runId, command } = await setup()
    const body = { leaseId: command.leaseId, status: "succeeded", result: { status: "completed" }, eventsToSeq: 2 }
    const early = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, body)
    expect(early.status).toBe(409)
    expect(await errorCode(early)).toBe("events_pending")
    const leased = (hub as Hub).db
      .query<{ status: string }, [string]>("SELECT status FROM commands WHERE id = ?")
      .get(command.commandId)
    expect(leased?.status).toBe("leased")
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("leased")

    await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/events`, {
      leaseId: command.leaseId,
      events: [
        { key: "c1:1", type: "run.started", at: new Date().toISOString(), data: {} },
        { key: "c1:2", type: "message.delta", at: new Date().toISOString(), data: { text: "ok" } },
      ],
    })
    const retry = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, body)
    expect(retry.status).toBe(200)
    const finished = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(finished?.status).toBe("completed")
  })

  test("a command cancelled by node loss returns fence_stale", async () => {
    const { node, command } = await setup()
    sweepHealth((hub as Hub).db, (hub as Hub).config, Date.now() + 46_000)
    const response = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe("fence_stale")
  })

  test("cancel of a queued run finishes it locally", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const run = await createRun(hub)
    const cancelled = await api(hub, "POST", `/v1/runs/${run.body.runId}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe("cancelled")
    const events = await api(hub, "GET", `/v1/runs/${run.body.runId}/events?after=0`)
    expect(events.body.events).toHaveLength(1)
    expect(events.body.events[0].type).toBe("run.finished")
    expect(events.body.events[0].data.status).toBe("cancelled")
    const command = hub.db
      .query<{ status: string }, [string]>("SELECT status FROM commands WHERE run_id = ?")
      .get(run.body.runId)
    expect(command?.status).toBe("cancelled")
  })

  test("cancel of a running run bumps the generation and queues a fenced command", async () => {
    const { node, runId, command } = await setup()
    const cancelled = await api(hub as Hub, "POST", `/v1/runs/${runId}/cancel`)
    expect(cancelled.status).toBe(202)
    expect(cancelled.body.generation).toBe(2)
    const queued = (hub as Hub).db
      .query<{ type: string; generation: number }, [string]>(
        "SELECT type, generation FROM commands WHERE run_id = ? AND type = 'run.cancel'",
      )
      .get(runId)
    expect(queued).toEqual({ type: "run.cancel", generation: 2 })

    const late = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "failed",
      error: { code: "cancelled", message: "cancelled" },
    })
    expect(late.status).toBe(409)
    expect(await errorCode(late)).toBe("fence_stale")
  })

  test("a second cancel does not bump the generation again", async () => {
    const { runId } = await setup()
    await api(hub as Hub, "POST", `/v1/runs/${runId}/cancel`)
    const again = await api(hub as Hub, "POST", `/v1/runs/${runId}/cancel`)
    expect(again.status).toBe(202)
    expect(again.body.generation).toBe(2)
    const count = (hub as Hub).db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM commands WHERE run_id = ? AND type = 'run.cancel'")
      .get(runId)
    expect(count?.n).toBe(1)
  })

  test("a queued cancel still ends cancelled when the node acknowledges", async () => {
    const { node, runId } = await setup()
    await api(hub as Hub, "POST", `/v1/runs/${runId}/cancel`)
    const cancelCommand = (await nextCommand(hub as Hub, node)).body
    expect(cancelCommand.type).toBe("run.cancel")
    expect(cancelCommand.generation).toBe(2)
    const ack = await signedFetch(hub as Hub, node, "POST", `/v1/node/commands/${cancelCommand.commandId}/complete`, {
      leaseId: cancelCommand.leaseId,
      status: "succeeded",
      result: { status: "completed" },
    })
    expect(ack.status).toBe(200)
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("cancelled")
    const events = await api(hub as Hub, "GET", `/v1/runs/${runId}/events?after=0`)
    expect(events.body.events.at(-1).type).toBe("run.finished")
    expect(events.body.events.at(-1).data.status).toBe("cancelled")
  })

  test("a queued cancel still ends cancelled when the node disconnects", async () => {
    const { runId } = await setup()
    await api(hub as Hub, "POST", `/v1/runs/${runId}/cancel`)
    sweepHealth((hub as Hub).db, (hub as Hub).config, Date.now() + 46_000)
    const runRow = (hub as Hub).db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    expect(runRow?.status).toBe("cancelled")
    const events = await api(hub as Hub, "GET", `/v1/runs/${runId}/events?after=0`)
    expect(events.body.events.at(-1).type).toBe("run.finished")
    expect(events.body.events.at(-1).data.status).toBe("cancelled")
  })
})
