import type { Database } from "bun:sqlite"
import type { PermissionPolicy, PermissionRequestView, PermissionStatus } from "@agenticform/protocol"
import { PERMISSION_TIMEOUT_MS } from "@agenticform/protocol"
import { enqueueCommand } from "./commands.ts"
import { fail } from "./errors.ts"
import { insertEvent } from "./events.ts"
import type { NodeRow, PermissionRequestRow, RunRow } from "./schema.ts"

/** Bounds on node-supplied strings the hub stores (FR-013). */
export const TOOL_CALL_ID_MAX_LENGTH = 128
export const PERMISSION_TITLE_MAX_LENGTH = 256
export const PERMISSION_KIND_MAX_LENGTH = 64

const TERMINAL = new Set<PermissionStatus>(["resolved", "timed_out", "cancelled"])
const OPTIONS: ("allow" | "deny")[] = ["allow", "deny"]

function view(row: PermissionRequestRow): PermissionRequestView {
  return {
    requestId: row.tool_call_id,
    generation: row.generation,
    title: row.title,
    kind: row.kind,
    options: OPTIONS,
    status: row.status as PermissionStatus,
    decision: row.decision === "allow" || row.decision === "deny" ? row.decision : null,
    by: row.decided_by === "policy" || row.decided_by === "admin" ? row.decided_by : null,
    requestedAt: new Date(row.requested_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

function get(db: Database, runId: string, generation: number, toolCallId: string): PermissionRequestRow | null {
  return db
    .query<PermissionRequestRow, [string, number, string]>(
      "SELECT * FROM permission_requests WHERE run_id = ? AND generation = ? AND tool_call_id = ?",
    )
    .get(runId, generation, toolCallId)
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null
}

/**
 * Bound the stored `permission.requested` data without dropping the event: a
 * long title or kind is truncated, so the batch is never rejected and the run
 * never stalls on a cosmetic field (T020).
 */
export function boundRequestedData(data: unknown): unknown {
  const body = data as { request?: unknown } | null
  if (body === null || typeof body !== "object") return data
  const request = body.request
  if (request === null || typeof request !== "object") return data
  const fields = request as Record<string, unknown>
  return {
    ...body,
    request: {
      ...fields,
      ...(typeof fields.title === "string"
        ? { title: fields.title.slice(0, PERMISSION_TITLE_MAX_LENGTH) }
        : {}),
      ...(typeof fields.kind === "string"
        ? { kind: fields.kind.slice(0, PERMISSION_KIND_MAX_LENGTH) }
        : {}),
    },
  }
}

/** The run's permission policy; a request stored before the field existed means "allow". */
export function policyOf(run: Pick<RunRow, "request_json">): PermissionPolicy {
  const policy = (JSON.parse(run.request_json) as { permissionPolicy?: unknown }).permissionPolicy
  return policy === "ask" || policy === "deny" ? policy : "allow"
}

/**
 * Record a `permission.requested` event as `pending`. The expiry is the
 * runtime's own deny clock, so the hub refuses a late answer before the
 * resolving event arrives (FR-010). A `toolCallId` over the bound is accepted
 * but not recorded, so the request simply cannot be answered remotely and the
 * runtime's timeout denies it.
 */
export function recordRequested(
  db: Database,
  runId: string,
  generation: number,
  data: unknown,
  now = Date.now(),
): void {
  const request = (data as { request?: Record<string, unknown> } | null)?.request
  if (request === null || typeof request !== "object") return
  const toolCallId = request.toolCallId
  if (typeof toolCallId !== "string" || !toolCallId) return
  if (toolCallId.length > TOOL_CALL_ID_MAX_LENGTH) return
  const title = bounded(request.title, PERMISSION_TITLE_MAX_LENGTH)
  const kind = bounded(request.kind, PERMISSION_KIND_MAX_LENGTH)
  const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId)
  const policy = run ? policyOf(run) : "ask"
  if (policy !== "ask") {
    // The policy answers at once, so nothing waits for an owner: keep the history only.
    db.query(
      `INSERT INTO permission_requests
         (run_id, generation, tool_call_id, title, kind, status, decision, requested_at, expires_at, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, 'resolved', ?, ?, ?, ?, 'policy')
       ON CONFLICT DO NOTHING`,
    ).run(runId, generation, toolCallId, title, kind, policy, now, now + PERMISSION_TIMEOUT_MS, now)
    return
  }
  db.query(
    `INSERT INTO permission_requests
       (run_id, generation, tool_call_id, title, kind, status, decision, requested_at, expires_at, decided_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)
     ON CONFLICT DO NOTHING`,
  ).run(runId, generation, toolCallId, title, kind, now, now + PERMISSION_TIMEOUT_MS)
}

/**
 * Record a `permission.resolved` event. An answered request becomes `resolved`;
 * an unanswered one becomes `timed_out` after its expiry, or `resolved` before
 * it (the harness cancelled it). A terminal row never changes.
 */
export function recordResolved(
  db: Database,
  runId: string,
  generation: number,
  data: unknown,
  now = Date.now(),
): void {
  const body = data as { toolCallId?: unknown; decision?: unknown } | null
  if (typeof body?.toolCallId !== "string" || !body.toolCallId) return
  const row = get(db, runId, generation, body.toolCallId)
  const decision = body.decision === "allow" || body.decision === "deny" ? body.decision : null
  if (row?.decided_by === "policy") {
    // The driver may deny an allow when the harness offered no one-time grant: the event is the truth.
    if (decision) {
      db.query(
        "UPDATE permission_requests SET decision = ? WHERE run_id = ? AND generation = ? AND tool_call_id = ?",
      ).run(decision, runId, generation, body.toolCallId)
    }
    return
  }
  if (!row || TERMINAL.has(row.status as PermissionStatus)) return
  if (row.status === "answered") {
    db.query(
      "UPDATE permission_requests SET status = 'resolved', decision = COALESCE(?, decision), decided_at = ? WHERE run_id = ? AND generation = ? AND tool_call_id = ? AND status = 'answered'",
    ).run(decision, now, runId, generation, body.toolCallId)
    return
  }
  const timedOut = now >= row.expires_at
  db.query(
    "UPDATE permission_requests SET status = ?, decision = ?, decided_at = ? WHERE run_id = ? AND generation = ? AND tool_call_id = ? AND status = 'pending'",
  ).run(timedOut ? "timed_out" : "resolved", timedOut ? "deny" : decision, now, runId, generation, body.toolCallId)
}

/** Run end or a fenced generation: every open request of the run is cancelled. */
export function cancelPending(db: Database, runId: string, now = Date.now()): void {
  db.query(
    "UPDATE permission_requests SET status = 'cancelled', decided_at = ? WHERE run_id = ? AND status IN ('pending','answered')",
  ).run(now, runId)
}

/** The run's requests in its current generation, oldest first. */
export function listPermissions(db: Database, runId: string): PermissionRequestView[] {
  const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId)
  if (!run) fail("not_found", "run not found")
  return db
    .query<PermissionRequestRow, [string, number]>(
      "SELECT * FROM permission_requests WHERE run_id = ? AND generation = ? ORDER BY requested_at, tool_call_id",
    )
    .all(runId, run.generation)
    .map(view)
}

function nodeSupportsRemote(db: Database, run: RunRow): boolean {
  if (!run.node_id) return false
  const node = db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(run.node_id)
  if (!node) return false
  return (JSON.parse(node.capabilities) as string[]).includes("permissions.remote")
}

/**
 * Accept exactly one owner answer. The conditional UPDATE is the whole race:
 * one caller changes the row, every other caller sees zero changes and is
 * refused. The command and the `permission.answered` event are written in the
 * same transaction (FR-009, SC-003).
 */
export function answerPermission(
  db: Database,
  runId: string,
  requestId: string,
  decision: unknown,
  now = Date.now(),
): PermissionRequestView {
  if (decision !== "allow" && decision !== "deny") fail("invalid_input", "decision must be allow or deny")
  const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId)
  if (!run) fail("not_found", "run not found")
  if (policyOf(run) !== "ask") {
    fail("permission_resolved", `the run's permission policy is ${policyOf(run)}; only policy ask takes remote answers`)
  }
  if (!nodeSupportsRemote(db, run)) {
    fail("permission_unsupported", "the run's node does not support remote permission answers")
  }
  const row = get(db, runId, run.generation, requestId)
  if (!row) fail("not_found", "permission request not found")
  if (row.status !== "pending") fail("permission_resolved", "the permission request is already settled")
  if (now >= row.expires_at) fail("permission_expired", "the permission request has expired")

  const write = db.transaction((): PermissionRequestView => {
    const updated = db
      .query(
        "UPDATE permission_requests SET status = 'answered', decision = ?, decided_at = ?, decided_by = 'admin' WHERE run_id = ? AND generation = ? AND tool_call_id = ? AND status = 'pending' AND expires_at > ?",
      )
      .run(decision, now, runId, run.generation, requestId, now)
    if (updated.changes !== 1) {
      const current = get(db, runId, run.generation, requestId)
      if (!current) fail("not_found", "permission request not found")
      if (current.status !== "pending") fail("permission_resolved", "the permission request is already settled")
      fail("permission_expired", "the permission request has expired")
    }
    enqueueCommand(
      db,
      run,
      "permission.answer",
      { toolCallId: requestId, decision },
      now,
      `:${requestId}`,
    )
    insertEvent(db, runId, {
      key: `hub:permission.answered:${run.generation}:${requestId}`,
      type: "permission.answered",
      at: new Date(now).toISOString(),
      data: { requestId, decision, by: "admin" },
    })
    return view(get(db, runId, run.generation, requestId) as PermissionRequestRow)
  })
  return write()
}
