import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { RunRequest, RunStatus, RunView } from "@agenticform/protocol"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@agenticform/protocol"
import type { HubConfig } from "./config.ts"
import { enqueueCommand } from "./commands.ts"
import { fail } from "./errors.ts"
import { insertEvent, hubEventKey, nextSeq } from "./events.ts"
import { cancelPending } from "./permissions.ts"
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
    parentRunId: request.parentRunId ?? null,
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
  if (request.requires !== undefined && request.requires.some((item) => typeof item !== "string")) {
    fail("invalid_input", "requires must be a string array")
  }
  if (request.labels !== undefined) {
    if (
      request.labels === null ||
      typeof request.labels !== "object" ||
      Array.isArray(request.labels) ||
      Object.values(request.labels).some((value) => typeof value !== "string")
    ) {
      fail("invalid_input", "labels must be a flat string map")
    }
  }
  if (request.mcpServers !== undefined && !Array.isArray(request.mcpServers)) {
    fail("invalid_input", "mcpServers must be an array")
  }
  if (request.gitBacked !== undefined && typeof request.gitBacked !== "boolean") {
    fail("invalid_input", "gitBacked must be a boolean")
  }
  if (request.cwd !== undefined && typeof request.cwd !== "string") {
    fail("invalid_input", "cwd must be a string")
  }
  if (request.nodeId !== undefined && typeof request.nodeId !== "string") {
    fail("invalid_input", "nodeId must be a string")
  }
  if (request.parentRunId !== undefined) {
    if (typeof request.parentRunId !== "string") fail("invalid_input", "parentRunId must be a string")
    if (!request.parentRunId) fail("invalid_input", "parentRunId is empty")
  }
}

export function createRun(
  db: Database,
  request: RunRequest,
  config: HubConfig,
  now = Date.now(),
): { run: RunRow; created: boolean } {
  valid(request)
  const requestJson = normalize(request)
  const existing = db
    .query<RunRow, [string]>("SELECT * FROM runs WHERE idempotency_key = ?")
    .get(request.idempotencyKey)
  if (existing) {
    // Compare normalised payloads, not raw strings: a row written before a
    // field gained a default would otherwise conflict on retry after upgrade.
    if (normalize(JSON.parse(existing.request_json) as RunRequest) !== requestJson) {
      fail("idempotency_conflict", "idempotency key reused with a different payload")
    }
    return { run: existing, created: false }
  }

  let depth = 0
  if (request.parentRunId !== undefined) {
    const parent = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(request.parentRunId)
    if (!parent) fail("parent_not_found", "parentRunId names no run")
    depth = parent.depth + 1
    if (depth > config.maxDepth) fail("depth_exceeded", `run depth ${depth} exceeds the limit of ${config.maxDepth}`)
  }

  if (request.nodeId !== undefined) {
    const pinned = db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(request.nodeId)
    if (pinned && !SUPPORTED_PROTOCOL_VERSIONS.includes(pinned.protocol_version)) {
      fail("version_unsupported", "node protocol version is not supported")
    }
  }

  const placement = pickNode(db, {
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
    const suffix = placement.bestStatus
      ? `: ${placement.bestStatus.status} on node ${placement.bestStatus.nodeId}`
      : placement.reason
        ? `: ${placement.reason}`
        : ""
    fail("no_eligible_node", `no node satisfies ${detail}${suffix}`)
  }

  const id = randomUUID()
  const cwd = request.cwd ?? `run/${id}`
  const workspace = `run/${id}`
  const write = db.transaction((): RunRow => {
    const reserved = db
      .query("UPDATE nodes SET capacity_in_use = capacity_in_use + 1 WHERE id = ? AND capacity_in_use < capacity_slots")
      .run(node.id)
    if (reserved.changes !== 1) fail("no_eligible_node", "node capacity was filled by another run")
    db.query(
      `INSERT INTO runs
         (id, idempotency_key, request_json, harness, prompt, cwd, requires_json, mcp_json, labels_json,
          git_backed, status, node_id, generation, workspace_id, created_at, updated_at, parent_run_id, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 1, ?, ?, ?, ?, ?)`,
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
      request.parentRunId ?? null,
      depth,
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
    parentRunId: run.parent_run_id,
    depth: run.depth,
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
    const pending = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM commands WHERE run_id = ? AND type = 'run.cancel' AND status IN ('queued','leased','running') LIMIT 1",
      )
      .get(run.id)
    if (pending) return { run, queued: true }

    // Bump the generation so an in-flight run.start completion or event batch
    // is fence_stale, then queue the cancel at the new generation (FR-022/023).
    const write = db.transaction((): RunRow => {
      const generation = run.generation + 1
      db.query("UPDATE runs SET generation = ?, updated_at = ? WHERE id = ? AND generation = ?").run(
        generation,
        now,
        run.id,
        run.generation,
      )
      // The old generation can no longer receive an answer (FR-011).
      cancelPending(db, run.id, now)
      const updated = getRun(db, run.id)
      enqueueCommand(db, updated, "run.cancel", {}, now)
      return updated
    })
    return { run: write(), queued: true }
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
    cancelPending(db, run.id, now)
    if (["queued", "leased", "running"].includes(run.status) && run.node_id) {
      db.query("UPDATE nodes SET capacity_in_use = MAX(capacity_in_use - 1, 0) WHERE id = ?").run(run.node_id)
    }
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

  const placement = pickNode(db, {
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
      `UPDATE runs SET status = 'queued', node_id = ?, generation = ?, workspace_id = ?, cwd = ?,
         result_json = NULL, error_json = NULL, disconnected_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'disconnected' AND generation = ?`,
    ).run(replacement.id, generation, workspace, workspace, now, run.id, run.generation)
    if (updated.changes !== 1) fail("recovery_precondition_failed", "run state changed during recovery")
    const reserved = db
      .query("UPDATE nodes SET capacity_in_use = capacity_in_use + 1 WHERE id = ? AND capacity_in_use < capacity_slots")
      .run(replacement.id)
    if (reserved.changes !== 1) fail("recovery_precondition_failed", "replacement node has no capacity")
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
