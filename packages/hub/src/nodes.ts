import type { Database } from "bun:sqlite"
import type { HeartbeatRequest, HeartbeatResponse, NodeView } from "@agenticform/protocol"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@agenticform/protocol"
import type { HubConfig } from "./config.ts"
import { fail } from "./errors.ts"
import { insertEvent, hubEventKey } from "./events.ts"
import type { NodeRow, RunRow } from "./schema.ts"

const ACTIVE_RUN = new Set(["queued", "leased", "running"])

export function heartbeat(
  db: Database,
  config: HubConfig,
  node: NodeRow,
  body: HeartbeatRequest,
  now = Date.now(),
): HeartbeatResponse {
  if (!Number.isInteger(body.protocolVersion)) {
    fail("invalid_input", "protocolVersion must be an integer")
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(body.protocolVersion)) {
    fail("version_unsupported", "protocol version is not supported")
  }
  if (!Array.isArray(body.harnesses)) fail("invalid_input", "harnesses must be an array")
  const inventory = Array.isArray(body.runtimes) ? body.runtimes : []
  const capabilities = Array.isArray(body.capabilities) ? body.capabilities : []
  const slots = body.capacity?.slots ?? node.capacity_slots
  const inUse = body.capacity?.inUse ?? node.capacity_in_use

  const write = db.transaction((): void => {
    db.query(
      `UPDATE nodes SET status = 'online', protocol_version = ?, harnesses = ?, capabilities = ?,
         capacity_slots = ?, capacity_in_use = ?, inventory = ?, last_heartbeat_at = ?
       WHERE id = ?`,
    ).run(
      body.protocolVersion,
      JSON.stringify(body.harnesses),
      JSON.stringify(capabilities),
      slots,
      inUse,
      JSON.stringify(inventory),
      now,
      node.id,
    )
    for (const entry of inventory) {
      const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(entry.runId)
      if (!run) continue
      const owned = run.node_id === node.id
      const current = entry.generation === run.generation
      if (!owned || !current || !ACTIVE_RUN.has(run.status)) {
        db.query("UPDATE nodes SET stale_observations = stale_observations + 1 WHERE id = ?").run(node.id)
        continue
      }
      db.query(
        `INSERT INTO runtime_assignments (run_id, node_id, generation, runtime_type, runtime_session_id, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, generation) DO UPDATE SET
           node_id = excluded.node_id, runtime_type = excluded.runtime_type,
           runtime_session_id = excluded.runtime_session_id, state = excluded.state, updated_at = excluded.updated_at`,
      ).run(run.id, node.id, entry.generation, entry.runtimeType, entry.runtimeSessionId, entry.state, now)
    }
  })
  write()

  return { status: "online", commandsPollMs: config.pollMs }
}

/** Fence and disconnect every active run on a node. Caller supplies the transaction. */
export function disconnectRuns(db: Database, nodeId: string, reason: string, now: number): number {
  const runs = db
    .query<RunRow, [string]>("SELECT * FROM runs WHERE node_id = ?")
    .all(nodeId)
    .filter((run) => ACTIVE_RUN.has(run.status))
  for (const run of runs) {
    const generation = run.generation + 1
    db.query(
      "UPDATE runs SET status = 'disconnected', generation = ?, disconnected_at = ?, updated_at = ? WHERE id = ?",
    ).run(generation, now, now, run.id)
    db.query(
      "UPDATE commands SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND status IN ('queued','leased','running')",
    ).run(now, run.id)
    db.query("UPDATE runtime_assignments SET state = 'fenced', updated_at = ? WHERE run_id = ? AND generation = ?").run(
      now,
      run.id,
      run.generation,
    )
    insertEvent(db, run.id, {
      key: hubEventKey("disconnected", generation),
      type: "run.disconnected",
      at: new Date(now).toISOString(),
      data: { status: "disconnected", nodeId, reason, generation },
    })
  }
  return runs.length
}

/** Mark silent nodes OFFLINE and disconnect their active runs (N7.1, FR-033). */
export function sweepHealth(db: Database, config: HubConfig, now = Date.now()): number {
  const cutoff = now - config.nodeOfflineMs
  const stale = db
    .query<NodeRow, [number]>(
      "SELECT * FROM nodes WHERE status = 'online' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)",
    )
    .all(cutoff)
  for (const node of stale) {
    const write = db.transaction((): void => {
      db.query("UPDATE nodes SET status = 'offline' WHERE id = ?").run(node.id)
      disconnectRuns(db, node.id, "node_offline", now)
    })
    write()
  }
  return stale.length
}

export function setNodeStatus(
  db: Database,
  nodeId: string,
  status: "disabled" | "revoked",
  now = Date.now(),
): NodeView {
  const node = db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(nodeId)
  if (!node) fail("not_found", "node not found")
  const write = db.transaction((): NodeView => {
    db.query("UPDATE nodes SET status = ? WHERE id = ?").run(status, nodeId)
    disconnectRuns(db, nodeId, status === "disabled" ? "node_disabled" : "node_revoked", now)
    return toNodeView({ ...node, status })
  })
  return write()
}

export function listNodes(db: Database): NodeView[] {
  return db.query<NodeRow, []>("SELECT * FROM nodes ORDER BY created_at").all().map(toNodeView)
}

export function toNodeView(node: NodeRow): NodeView {
  return {
    nodeId: node.id,
    name: node.name,
    status: node.status,
    protocolVersion: node.protocol_version,
    harnesses: JSON.parse(node.harnesses) as string[],
    capabilities: JSON.parse(node.capabilities) as string[],
    labels: JSON.parse(node.labels) as Record<string, string>,
    capacity: { slots: node.capacity_slots, inUse: node.capacity_in_use },
    lastHeartbeatAt: node.last_heartbeat_at === null ? null : new Date(node.last_heartbeat_at).toISOString(),
  }
}
