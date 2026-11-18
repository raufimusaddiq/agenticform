import type { Database } from "bun:sqlite"
import type { HarnessReport, HarnessStatus } from "@agenticform/protocol"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@agenticform/protocol"
import type { NodeRow } from "./schema.ts"

export interface PlacementFilter {
  harness: string
  requires?: readonly string[]
  nodeId?: string
  labels?: Readonly<Record<string, string>>
}

export function nodeSupports(node: NodeRow, filter: PlacementFilter): boolean {
  if (node.status !== "online") return false
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(node.protocol_version)) return false
  const harnesses = JSON.parse(node.harnesses) as string[]
  if (!harnesses.includes(filter.harness)) return false
  const capabilities = new Set(JSON.parse(node.capabilities) as string[])
  for (const capability of filter.requires ?? []) if (!capabilities.has(capability)) return false
  if (!labelsMatch(node, filter)) return false
  if (node.capacity_in_use >= node.capacity_slots) return false
  return true
}

function labelsMatch(node: NodeRow, filter: PlacementFilter): boolean {
  const labels = JSON.parse(node.labels) as Record<string, string>
  return Object.entries(filter.labels ?? {}).every(([key, value]) => labels[key] === value)
}

/** Filter, then least-loaded, then oldest heartbeat. No scoring, no affinity (plan: Placement). */
export function pickNode(
  db: Database,
  filter: PlacementFilter,
): {
  node: NodeRow | null
  capabilityMissing: boolean
  bestStatus?: { nodeId: string; status: HarnessStatus }
  reason?: "capacity" | "protocol" | "labels"
} {
  const all = db.query<NodeRow, []>("SELECT * FROM nodes WHERE status = 'online'").all()
  const candidates = all.filter((node) => (filter.nodeId ? node.id === filter.nodeId : true))
  const eligible = candidates.filter((node) => nodeSupports(node, filter))
  if (eligible.length === 0) {
    const capabilityMissing =
      candidates.length > 0 &&
      (filter.requires?.length ?? 0) > 0 &&
      candidates.some((node) => {
        const capabilities = new Set(JSON.parse(node.capabilities) as string[])
        return [...(filter.requires ?? [])].some((capability) => !capabilities.has(capability))
      })
    // FR-025: only a non-ready status explains why the harness was not placed.
    const rank: Record<Exclude<HarnessStatus, "ready">, number> = { unauthenticated: 3, unknown: 2, missing: 1 }
    let best: { nodeId: string; status: HarnessStatus } | undefined
    for (const node of candidates) {
      const report = JSON.parse(node.harness_report) as HarnessReport[]
      const entry = report.find((item) => item.id === filter.harness)
      if (!entry || entry.status === "ready") continue
      if (!best || rank[entry.status] > rank[best.status as Exclude<HarnessStatus, "ready">]) {
        best = { nodeId: node.id, status: entry.status }
      }
    }
    // A node that reported the harness ready but was ineligible for another
    // reason: name that reason instead of a misleading "ready".
    let reason: "capacity" | "protocol" | "labels" | undefined
    if (!best) {
      if (candidates.some((node) => node.capacity_in_use >= node.capacity_slots)) reason = "capacity"
      else if (candidates.some((node) => !SUPPORTED_PROTOCOL_VERSIONS.includes(node.protocol_version))) reason = "protocol"
      else if (candidates.some((node) => !labelsMatch(node, filter))) reason = "labels"
    }
    return {
      node: null,
      capabilityMissing,
      ...(best === undefined ? {} : { bestStatus: best }),
      ...(reason === undefined ? {} : { reason }),
    }
  }
  eligible.sort((a, b) => {
    if (a.capacity_in_use !== b.capacity_in_use) return a.capacity_in_use - b.capacity_in_use
    return (a.last_heartbeat_at ?? 0) - (b.last_heartbeat_at ?? 0)
  })
  return { node: eligible[0] ?? null, capabilityMissing: false }
}
