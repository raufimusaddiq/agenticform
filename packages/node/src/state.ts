import type { CommandEnvelope } from "@agenticform/protocol"
import { commandFingerprint } from "@agenticform/protocol/canonical"

export type CommandAdmission = "new" | "replay" | "conflict"

/**
 * Node-owned monotonic state (FR-021, FR-024, FR-028). The executor asks this
 * for the current generation instead of keeping a second copy, so a snapshot
 * from an older generation can never replace a newer one.
 */
export class NodeState {
  private readonly generations = new Map<string, number>()
  private readonly commands = new Map<string, string>()

  /** Highest generation accepted for a run, or null when the run is unseen. */
  currentGeneration(runId: string): number | null {
    return this.generations.get(runId) ?? null
  }

  /**
   * Record a generation only when it is not older than the current one (N4.3).
   * Returns false when the caller's generation is stale, in which case nothing
   * was stored.
   */
  advance(runId: string, generation: number): boolean {
    const current = this.generations.get(runId)
    if (current !== undefined && generation < current) return false
    if (current === undefined || generation > current) this.generations.set(runId, generation)
    return true
  }

  /**
   * First delivery of a command id admits; an identical repeat is a replay (the
   * ledger makes duplicates safe in a later task); a changed fingerprint is a
   * conflict and must not run (FR-028, N5.3).
   */
  admit(command: CommandEnvelope): CommandAdmission {
    const fingerprint = fingerprintOf(command)
    const seen = this.commands.get(command.commandId)
    if (seen === undefined) {
      this.commands.set(command.commandId, fingerprint)
      return "new"
    }
    return seen === fingerprint ? "replay" : "conflict"
  }
}

/** FR-021: the signed payload generation must equal the envelope generation. */
export function payloadGenerationError(command: CommandEnvelope): string | null {
  return command.payload.generation === command.generation
    ? null
    : "payload generation differs from envelope"
}

/** N5.3: SHA-256 over type, idempotency key, generation and the payload. */
export function fingerprintOf(command: CommandEnvelope): string {
  const { fingerprint: _wireFingerprint, ...payload } = command.payload
  return commandFingerprint(
    command.type,
    command.idempotencyKey,
    command.generation,
    JSON.stringify(payload),
  )
}
