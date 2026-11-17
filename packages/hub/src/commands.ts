import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type {
  CommandEnvelope,
  CommandPayload,
  CommandType,
  CompletionRequest,
} from "@agenticform/protocol"
import { commandFingerprint } from "@agenticform/protocol/canonical"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@agenticform/protocol"
import type { HubConfig } from "./config.ts"
import { fail } from "./errors.ts"
import { insertEvent } from "./events.ts"
import type { CommandRow, NodeRow, RunRow } from "./schema.ts"

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"])

export function toEnvelope(row: CommandRow): CommandEnvelope {
  return {
    commandId: row.id,
    type: row.type as CommandType,
    runId: row.run_id,
    generation: row.generation,
    idempotencyKey: row.idempotency_key,
    leasedUntil: new Date(row.leased_until ?? 0).toISOString(),
    payload: JSON.parse(row.payload_json) as CommandPayload,
  }
}

/**
 * Enqueue is keyed by `(run_id, idempotency_key)` (N5.1). A repeat with the same
 * body returns the existing row; a differing body is an idempotency conflict.
 */
export function enqueueCommand(
  db: Database,
  run: RunRow,
  type: CommandType,
  payload: Record<string, unknown>,
  now = Date.now(),
): CommandRow {
  const idempotencyKey = `run:${run.id}:${type}:${run.generation}`
  const body = { ...payload, generation: run.generation }
  const payloadJson = JSON.stringify(body)
  const fingerprint = commandFingerprint(type, idempotencyKey, run.generation, payloadJson)
  const sentJson = JSON.stringify({ ...body, fingerprint })
  const existing = db
    .query<CommandRow, [string, string]>(
      "SELECT * FROM commands WHERE run_id = ? AND idempotency_key = ?",
    )
    .get(run.id, idempotencyKey)
  if (existing) {
    if (existing.payload_json !== sentJson) fail("idempotency_conflict", "command payload differs")
    return existing
  }
  const id = randomUUID()
  db.query(
    `INSERT INTO commands
       (id, run_id, node_id, type, idempotency_key, generation, payload_json, fingerprint, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(
    id,
    run.id,
    run.node_id ?? "",
    type,
    idempotencyKey,
    run.generation,
    sentJson,
    fingerprint,
    now,
    now,
  )
  return db.query<CommandRow, [string]>("SELECT * FROM commands WHERE id = ?").get(id) as CommandRow
}

/** Lease one command for this node, fencing stale queued work first (N4.2). */
export function leaseNext(
  db: Database,
  config: HubConfig,
  node: NodeRow,
  now = Date.now(),
): CommandEnvelope | null {
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(node.protocol_version)) {
    fail("version_unsupported", "node protocol version is not supported")
  }
  db.query(
    `UPDATE commands SET status = 'cancelled', updated_at = ?
     WHERE node_id = ? AND status = 'queued'
       AND (generation != (SELECT generation FROM runs WHERE runs.id = commands.run_id)
            OR (SELECT status FROM runs WHERE runs.id = commands.run_id) IN ('completed','failed','cancelled','disconnected'))`,
  ).run(now, node.id)

  const row = db
    .query<CommandRow, [string]>(
      `SELECT c.* FROM commands c JOIN runs r ON r.id = c.run_id
       WHERE c.node_id = ? AND c.status = 'queued' AND c.generation = r.generation
         AND r.status IN ('queued','leased','running')
       ORDER BY c.created_at LIMIT 1`,
    )
    .get(node.id)
  if (!row) return null

  const leaseId = randomUUID()
  const leasedUntil = now + config.leaseMs
  const leased = db
    .query(
      `UPDATE commands SET status = 'leased', lease_id = ?, leased_until = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND generation = ?`,
    )
    .run(leaseId, leasedUntil, now, row.id, row.generation)
  if (leased.changes !== 1) return null

  db.query("UPDATE runs SET status = 'leased', updated_at = ? WHERE id = ? AND status = 'queued'").run(
    now,
    row.run_id,
  )
  return toEnvelope({ ...row, status: "leased", lease_id: leaseId, leased_until: leasedUntil })
}

export function renewLease(
  db: Database,
  config: HubConfig,
  node: NodeRow,
  commandId: string,
  now = Date.now(),
): { leasedUntil: string } {
  const command = db.query<CommandRow, [string]>("SELECT * FROM commands WHERE id = ?").get(commandId)
  if (!command || command.node_id !== node.id) fail("lease_not_held", "lease not held")
  const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(command.run_id)
  if (!run || command.generation !== run.generation) fail("lease_not_held", "generation advanced")
  const leasedUntil = now + config.leaseMs
  const renewed = db
    .query(
      `UPDATE commands SET leased_until = ?, updated_at = ?
       WHERE id = ? AND node_id = ? AND lease_id = ? AND status IN ('leased','running') AND leased_until > ?`,
    )
    .run(leasedUntil, now, command.id, node.id, command.lease_id, now)
  if (renewed.changes !== 1) fail("lease_not_held", "lease expired or command cancelled")
  return { leasedUntil: new Date(leasedUntil).toISOString() }
}

/** Completion is idempotent for an identical result and rejects conflicts (N5.2). */
export function completeCommand(
  db: Database,
  node: NodeRow,
  commandId: string,
  body: CompletionRequest,
  now = Date.now(),
): CommandRow {
  if (body.status !== "succeeded" && body.status !== "failed") {
    fail("invalid_input", "status must be succeeded or failed")
  }
  const command = db.query<CommandRow, [string]>("SELECT * FROM commands WHERE id = ?").get(commandId)
  if (!command || command.node_id !== node.id) fail("lease_not_held", "lease not held")

  const resultJson = body.result === undefined ? null : JSON.stringify(body.result)
  const errorJson = body.error === undefined ? null : JSON.stringify(body.error)
  const target = body.status === "succeeded" ? "succeeded" : "failed"

  if (command.status === "succeeded" || command.status === "failed" || command.status === "cancelled") {
    const same =
      command.status === target && command.result_json === resultJson && command.error_json === errorJson
    if (!same) fail("idempotency_conflict", "a different terminal result already exists")
    return command
  }
  if (command.status !== "leased" && command.status !== "running") {
    fail("lease_not_held", "command is not leased")
  }

  const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(command.run_id)
  if (!run) fail("not_found", "run not found")
  if (command.leased_until === null || command.leased_until <= now) {
    fail("lease_not_held", "lease expired")
  }
  if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
    fail("fence_stale", "run is terminal")
  }
  if (command.generation !== run.generation) {
    db.query("UPDATE commands SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, command.id)
    fail("fence_stale", "generation advanced before completion")
  }

  const write = db.transaction((): CommandRow => {
    db.query(
      "UPDATE commands SET status = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ?",
    ).run(target, resultJson, errorJson, now, command.id)
    const runStatus = target === "succeeded" ? "completed" : "failed"
    db.query(
      "UPDATE runs SET status = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ?",
    ).run(runStatus, resultJson, errorJson, now, run.id)
    insertEvent(db, run.id, {
      key: "hub:finished",
      type: "run.finished",
      at: new Date(now).toISOString(),
      data: { status: runStatus, ...(resultJson === null ? {} : { result: JSON.parse(resultJson) }), ...(errorJson === null ? {} : { error: JSON.parse(errorJson) }) },
    })
    return db.query<CommandRow, [string]>("SELECT * FROM commands WHERE id = ?").get(command.id) as CommandRow
  })

  return write()
}

export function cancelCommand(
  db: Database,
  run: RunRow,
  now = Date.now(),
): void {
  db.query(
    `UPDATE commands SET status = 'cancelled', updated_at = ?
     WHERE run_id = ? AND status IN ('queued','leased','running')`,
  ).run(now, run.id)
}

export function terminalRun(run: RunRow): boolean {
  return TERMINAL_RUN.has(run.status)
}
