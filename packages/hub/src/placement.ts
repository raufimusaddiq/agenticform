import type { Database } from "bun:sqlite"
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
  const labels = JSON.parse(node.labels) as Record<string, string>
  for (const [key, value] of Object.entries(filter.labels ?? {})) {
    if (labels[key] !== value) return false
  }
  if (node.capacity_in_use >= node.capacity_slots) return false
  return true
}

/** Filter, then least-loaded, then oldest heartbeat. No scoring, no affinity (plan: Placement). */
export function pickNode(
  db: Database,
  filter: PlacementFilter,
): { node: NodeRow | null; capabilityMissing: boolean } {
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
    return { node: null, capabilityMissing }
  }
  eligible.sort((a, b) => {
    if (a.capacity_in_use !== b.capacity_in_use) return a.capacity_in_use - b.capacity_in_use
    return (a.last_heartbeat_at ?? 0) - (b.last_heartbeat_at ?? 0)
  })
  return { node: eligible[0] ?? null, capabilityMissing: false }
}
