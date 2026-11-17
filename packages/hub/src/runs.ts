import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { RunRequest, RunStatus, RunView } from "@agenticform/protocol"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@agenticform/protocol"
import type { HubConfig } from "./config.ts"
import { enqueueCommand } from "./commands.ts"
import { fail } from "./errors.ts"
import { insertEvent, hubEventKey, nextSeq } from "./events.ts"
import { pickNode } from "./placement.ts"
import type { NodeRow, RunRow } from "./schema.ts"

const TERMINAL = new Set(["completed", "failed", "cancelled"])

function normalize(request: RunRequest): string {
  return JSON.stringify({
    idempotencyKey: request.idempotencyKey,
    harness: request.harness,
    prompt: request.prompt,
    cwd: request.cwd ?? null,
    requires: request.requires ?? [],
    mcpServers: request.mcpServers ?? [],
    nodeId: request.nodeId ?? null,
    labels: request.labels ?? {},
    gitBacked: request.gitBacked ?? true,
  })
}

function valid(request: RunRequest): void {
  if (typeof request.idempotencyKey !== "string" || !request.idempotencyKey) {
    fail("invalid_input", "idempotencyKey is required")
  }
  if (typeof request.harness !== "string" || !request.harness) fail("invalid_input", "harness is required")
  if (typeof request.prompt !== "string" || !request.prompt) fail("invalid_input", "prompt is required")
  if (request.requires !== undefined && !Array.isArray(request.requires)) {
    fail("invalid_input", "requires must be an array")
  }
}

export function createRun(
  db: Database,
  config: HubConfig,
  request: RunRequest,
  now = Date.now(),
): { run: RunRow; created: boolean } {
  valid(request)
  const requestJson = normalize(request)
  const existing = db
    .query<RunRow, [string]>("SELECT * FROM runs WHERE idempotency_key = ?")
    .get(request.idempotencyKey)
  if (existing) {
    if (existing.request_json !== requestJson) fail("idempotency_conflict", "idempotency key reused with a different payload")
    return { run: existing, created: false }
  }

  if (request.nodeId !== undefined) {
    const pinned = db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(request.nodeId)
    if (pinned && !SUPPORTED_PROTOCOL_VERSIONS.includes(pinned.protocol_version)) {
      fail("version_unsupported", "node protocol version is not supported")
    }
  }

  const placement = pickNode(db, config, {
    harness: request.harness,
    ...(request.requires === undefined ? {} : { requires: request.requires }),
    ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
    ...(request.labels === undefined ? {} : { labels: request.labels }),
  })
  const node = placement.node
  if (!node) {
    const detail = request.requires?.length
      ? `${request.harness} + ${request.requires.join(" + ")}`
      : request.harness
    if (placement.capabilityMissing) fail("capability_missing", `no node advertises ${detail}`)
    fail("no_eligible_node", `no node satisfies ${detail}`)
  }

  const id = randomUUID()
  const cwd = request.cwd ?? `run/${id}`
  const workspace = `run/${id}`
  const write = db.transaction((): RunRow => {
    db.query(
      `INSERT INTO runs
         (id, idempotency_key, request_json, harness, prompt, cwd, requires_json, mcp_json, labels_json,
          git_backed, status, node_id, generation, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 1, ?, ?, ?)`,
    ).run(
      id,
      request.idempotencyKey,
      requestJson,
      request.harness,
      request.prompt,
      cwd,
      JSON.stringify(request.requires ?? []),
      JSON.stringify(request.mcpServers ?? []),
      JSON.stringify(request.labels ?? {}),
      request.gitBacked === false ? 0 : 1,
      node.id,
      workspace,
      now,
      now,
    )
    db.query(
      `INSERT INTO runtime_assignments (run_id, node_id, generation, runtime_type, runtime_session_id, state, updated_at)
       VALUES (?, ?, 1, ?, NULL, 'assigned', ?)`,
    ).run(id, node.id, request.harness, now)
    const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id) as RunRow
    enqueueCommand(
      db,
      run,
      "run.start",
      {
        harness: request.harness,
        cwd,
        prompt: request.prompt,
        requires: request.requires ?? [],
        mcpServers: request.mcpServers ?? [],
      },
      now,
    )
    return run
  })
  return { run: write(), created: true }
}

export function runView(db: Database, run: RunRow): RunView {
  const view: RunView = {
    runId: run.id,
    status: run.status as RunStatus,
    nodeId: run.node_id,
    generation: run.generation,
    createdAt: new Date(run.created_at).toISOString(),
    lastSeq: nextSeq(db, run.id) - 1,
  }
  if (run.result_json !== null) view.result = JSON.parse(run.result_json) as unknown
  if (run.error_json !== null) view.error = JSON.parse(run.error_json) as { code: string; message: string }
  return view
}

export function getRun(db: Database, runId: string): RunRow {
  const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId)
  if (!run) fail("not_found", "run not found")
  return run
}

/** Queue a fenced cancel, or finish it locally when the node cannot be reached. */
export function cancelRun(
  db: Database,
  runId: string,
  now = Date.now(),
): { run: RunRow; queued: boolean } {
  const run = getRun(db, runId)
  if (TERMINAL.has(run.status)) return { run, queued: false }
  const node = run.node_id
    ? db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(run.node_id)
    : null
  const reachable =
    run.status !== "disconnected" &&
    (run.status === "leased" || run.status === "running") &&
    node?.status === "online"
  if (reachable) {
    enqueueCommand(db, run, "run.cancel", {}, now)
    return { run, queued: true }
  }

  // Disconnected, unreachable or still queued: finish at the hub. Bump the
  // generation so a late node completion can never apply (FR-023, FR-033).
  const write = db.transaction((): RunRow => {
    const generation = run.generation + 1
    db.query(
      "UPDATE runs SET status = 'cancelled', generation = ?, updated_at = ? WHERE id = ?",
    ).run(generation, now, run.id)
    db.query(
      "UPDATE commands SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND status IN ('queued','leased','running')",
    ).run(now, run.id)
    db.query(
      "UPDATE runtime_assignments SET state = 'fenced', updated_at = ? WHERE run_id = ? AND generation = ?",
    ).run(now, run.id, run.generation)
    insertEvent(db, run.id, {
      key: hubEventKey("finished", generation),
      type: "run.finished",
      at: new Date(now).toISOString(),
      data: { status: "cancelled" },
    })
    return getRun(db, run.id)
  })
  return { run: write(), queued: false }
}

/**
 * Explicit recovery. Every precondition is checked before anything is written
 * (FR-034). A new generation and a new workspace are assigned; the old
 * generation is fenced out by the generation bump (FR-035, FR-025).
 */
export function recoverRun(
  db: Database,
  config: HubConfig,
  runId: string,
  now = Date.now(),
): RunRow {
  const run = getRun(db, runId)
  if (run.status !== "disconnected") fail("recovery_precondition_failed", "run is not disconnected")
  const node = run.node_id
    ? db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(run.node_id)
    : null
  if (!node) fail("recovery_precondition_failed", "run has no assigned node")
  if (node.status !== "offline") fail("recovery_precondition_failed", "assigned node is not offline")
  if (run.disconnected_at === null || now - run.disconnected_at < config.recoveryGraceMs) {
    fail("recovery_precondition_failed", "recovery grace period has not elapsed")
  }
  if (run.git_backed !== 1) fail("recovery_precondition_failed", "workspace is not GIT-backed")
  if (run.pending_approval !== 0) fail("recovery_precondition_failed", "a pending approval blocks recovery")

  const placement = pickNode(db, config, {
    harness: run.harness,
    requires: JSON.parse(run.requires_json) as string[],
    ...(Object.keys(JSON.parse(run.labels_json) as Record<string, string>).length
      ? { labels: JSON.parse(run.labels_json) as Record<string, string> }
      : {}),
  })
  const replacement = placement.node
  if (!replacement) fail("recovery_precondition_failed", "no eligible replacement node")

  const generation = run.generation + 1
  const workspace = `run/${run.id}/g${generation}`
  const write = db.transaction((): RunRow => {
    const updated = db.query(
      `UPDATE runs SET status = 'queued', node_id = ?, generation = ?, workspace_id = ?,
         result_json = NULL, error_json = NULL, disconnected_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'disconnected' AND generation = ?`,
    ).run(replacement.id, generation, workspace, now, run.id, run.generation)
    if (updated.changes !== 1) fail("recovery_precondition_failed", "run state changed during recovery")
    db.query(
      `INSERT INTO runtime_assignments (run_id, node_id, generation, runtime_type, runtime_session_id, state, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'assigned', ?)`,
    ).run(run.id, replacement.id, generation, run.harness, now)
    const updatedRun = getRun(db, run.id)
    enqueueCommand(
      db,
      updatedRun,
      "run.start",
      {
        harness: run.harness,
        cwd: workspace,
        prompt: run.prompt,
        requires: JSON.parse(run.requires_json) as string[],
        mcpServers: JSON.parse(run.mcp_json) as unknown[],
      },
      now,
    )
    return updatedRun
  })
  return write()
}
