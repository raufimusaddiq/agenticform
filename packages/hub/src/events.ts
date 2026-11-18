import type { Database } from "bun:sqlite"
import type { EventBatch, EventBatchResponse, RunEventWire } from "@agenticform/protocol"
import { fail } from "./errors.ts"
import { recordRequested, recordResolved } from "./permissions.ts"
import type { CommandRow, EventRow, RunRow } from "./schema.ts"

const TERMINAL = new Set(["completed", "failed", "cancelled", "disconnected"])

export function nextSeq(db: Database, runId: string): number {
  const row = db
    .query<{ seq: number | null }, [string]>("SELECT MAX(seq) AS seq FROM run_events WHERE run_id = ?")
    .get(runId)
  return (row?.seq ?? 0) + 1
}

/** Hub-generated event keys are generation-scoped so a recovered run can repeat a lifecycle event. */
export function hubEventKey(type: "disconnected" | "finished", generation: number): string {
  return `hub:${type}:${generation}`
}

export function insertEvent(
  db: Database,
  runId: string,
  event: { key: string; type: string; at: string; data: unknown },
): number {
  const seq = nextSeq(db, runId)
  const inserted = db
    .query(
      "INSERT INTO run_events (run_id, seq, key, type, at, data_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .run(runId, seq, event.key, event.type, event.at, JSON.stringify(event.data))
  return inserted.changes === 1 ? seq : 0
}

export function appendEvents(
  db: Database,
  nodeId: string,
  commandId: string,
  batch: EventBatch,
  now = Date.now(),
): EventBatchResponse {
  if (!Array.isArray(batch.events)) fail("invalid_input", "events must be an array")
  if (batch.events.length > 1_000) fail("invalid_input", "events exceeds the maximum batch size")
  const command = db.query<CommandRow, [string]>("SELECT * FROM commands WHERE id = ?").get(commandId)
  if (!command || command.node_id !== nodeId) fail("fence_stale", "unknown command for this node")
  if (typeof batch.leaseId !== "string" || batch.leaseId !== command.lease_id) {
    fail("fence_stale", "lease not held")
  }
  if (command.status !== "leased" && command.status !== "running") {
    fail("fence_stale", "command is not leased")
  }
  if (command.leased_until === null || command.leased_until <= now) fail("fence_stale", "lease expired")
  const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(command.run_id)
  if (!run || command.generation !== run.generation) fail("fence_stale", "generation advanced")
  if (TERMINAL.has(run.status)) fail("fence_stale", "run is terminal")

  for (const event of batch.events) {
    if (typeof event.key !== "string" || !event.key) fail("invalid_input", "event key is required")
    if (typeof event.type !== "string" || !event.type) fail("invalid_input", "event type is required")
    if (typeof event.at !== "string") fail("invalid_input", "event at is required")
  }

  const write = db.transaction((): number => {
    let accepted = 0
    for (const event of batch.events) {
      // Node keys are namespaced by generation so a recovered generation can reuse
      // a key like `c1:1` without colliding with the fenced-out generation.
      const key = `g${command.generation}:${event.key}`
      accepted += insertEvent(db, run.id, { ...event, key }) > 0 ? 1 : 0
      // The permission state machine follows the events that the harness already
      // sent, in the same transaction as the insert (T025).
      if (event.type === "permission.requested") {
        recordRequested(db, run.id, command.generation, event.data, now)
      } else if (event.type === "permission.resolved") {
        recordResolved(db, run.id, command.generation, event.data, now)
      }
    }
    if (command.status === "leased") {
      db.query("UPDATE commands SET status = 'running', updated_at = ? WHERE id = ?").run(now, command.id)
    }
    if (run.status === "queued" || run.status === "leased") {
      db.query("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").run(now, run.id)
    }
    return accepted
  })

  const accepted = write()
  return { accepted, lastSeq: nextSeq(db, run.id) - 1 }
}

export function listEvents(db: Database, runId: string, after = 0): RunEventWire[] {
  const rows = db
    .query<EventRow, [string, number]>(
      "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq",
    )
    .all(runId, after)
  return rows.map((row) => ({
    seq: row.seq,
    key: row.key,
    type: row.type,
    at: row.at,
    data: JSON.parse(row.data_json) as unknown,
  }))
}
