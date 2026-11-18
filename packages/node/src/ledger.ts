import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import type { CommandEnvelope } from "@agenticform/protocol"
import { fingerprintOf } from "./state.ts"

export interface LedgerOutcome {
  status: "succeeded" | "failed"
  result?: unknown
  error?: { code: string; message: string }
}

export type LedgerAdmission =
  | { kind: "new" }
  | { kind: "replay"; outcome: LedgerOutcome }
  | { kind: "conflict" }
  | { kind: "ambiguous"; message: string }
  | { kind: "invalid"; message: string }

export interface LedgerOptions {
  /** Ledger directory (`$stateDir/ledger`). Omitted keeps the ledger in memory. */
  dir?: string
  /** Terminal entries older than this are dropped. Default 7 days. */
  retentionMs?: number
}

interface Entry {
  commandId: string
  fingerprint: string
  status: "started" | "succeeded" | "failed"
  result?: unknown
  error?: { code: string; message: string }
  updatedAt: string
}

/** Command ids name a file, so anything outside this set is refused (N6.1). */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Durable command receipts (FR-029..FR-032, N6). One file per command: `started`
 * is written before the effect, the terminal result replaces it, and a `started`
 * entry seen again is refused rather than replayed.
 */
export class CommandLedger {
  private readonly dir: string | undefined
  private readonly retentionMs: number
  private readonly entries = new Map<string, Entry>()

  constructor(options: LedgerOptions = {}) {
    this.dir = options.dir
    this.retentionMs = options.retentionMs ?? WEEK_MS
    this.compact()
  }

  /**
   * Decide whether the command may run now. `new` persists `started` first;
   * `replay` returns the cached terminal outcome; `conflict` and `ambiguous`
   * must not reach the runtime (FR-028, FR-031, N5.3, N6.3).
   */
  admit(command: CommandEnvelope): LedgerAdmission {
    const fingerprint = fingerprintOf(command)
    const existing = this.load(command.commandId)
    if (existing === "unreadable") {
      return { kind: "ambiguous", message: "command ledger entry is unreadable" }
    }
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" }
      if (existing.status === "started") {
        return {
          kind: "ambiguous",
          message: "previous command execution was interrupted; refusing an unsafe replay",
        }
      }
      return { kind: "replay", outcome: outcomeOf(existing) }
    }
    const stored = this.store({
      commandId: command.commandId,
      fingerprint,
      status: "started",
      updatedAt: new Date().toISOString(),
    })
    return stored ? { kind: "new" } : { kind: "invalid", message: "command id is not a safe ledger key" }
  }

  /** Cache the terminal result so a re-lease after a lost completion replays it (FR-030). */
  settle(command: CommandEnvelope, outcome: LedgerOutcome): void {
    this.store({
      commandId: command.commandId,
      fingerprint: fingerprintOf(command),
      status: outcome.status,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      updatedAt: new Date().toISOString(),
    })
    // ponytail: one readdir per settled command; move to a timer if a node ever
    // leases fast enough that the scan shows up in profiles.
    this.compact()
  }

  /** FR-032: drop terminal entries past the retention window; never drop `started`. */
  compact(now = Date.now()): number {
    if (this.dir === undefined) return 0
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const path = join(this.dir, name)
      const entry = this.readFile(path)
      if (entry === null || entry.status === "started") continue
      if (now - Date.parse(entry.updatedAt) <= this.retentionMs) continue
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      this.entries.delete(entry.commandId)
      removed += 1
    }
    return removed
  }

  private load(commandId: string): Entry | "unreadable" | null {
    const cached = this.entries.get(commandId)
    if (cached) return cached
    if (this.dir === undefined || !SAFE_ID.test(commandId)) return null
    const path = join(this.dir, `${commandId}.json`)
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch (error) {
      // Only a missing file means "unseen"; any other read failure is ambiguous.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable"
    }
    const entry = parse(raw, commandId)
    if (entry === null) return "unreadable"
    this.entries.set(commandId, entry)
    return entry
  }

  private readFile(path: string): Entry | null {
    try {
      return parse(readFileSync(path, "utf8"), basename(path, ".json"))
    } catch {
      return null
    }
  }

  private store(entry: Entry): boolean {
    if (this.dir === undefined) {
      this.entries.set(entry.commandId, entry)
      return true
    }
    if (!SAFE_ID.test(entry.commandId)) return false
    const path = join(this.dir, `${entry.commandId}.json`)
    writeAtomic(path, JSON.stringify(entry, null, 2) + "\n")
    this.entries.set(entry.commandId, entry)
    return true
  }
}

const outcomeOf = (entry: Entry): LedgerOutcome =>
  entry.status === "succeeded"
    ? { status: "succeeded", ...(entry.result === undefined ? {} : { result: entry.result }) }
    : { status: "failed", ...(entry.error === undefined ? {} : { error: entry.error }) }

const parse = (raw: string, commandId: string): Entry | null => {
  try {
    const entry = JSON.parse(raw) as Partial<Entry>
    if (entry.commandId !== commandId) return null
    if (typeof entry.fingerprint !== "string") return null
    if (entry.status !== "started" && entry.status !== "succeeded" && entry.status !== "failed") return null
    if (typeof entry.updatedAt !== "string" || Number.isNaN(Date.parse(entry.updatedAt))) return null
    return entry as Entry
  } catch {
    return null
  }
}

/** Temp file, `fsync`, `rename`, mode `0600` — atomic in the same directory (N6.1). */
const writeAtomic = (path: string, data: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const fd = openSync(tmp, "w", 0o600)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (error) {
    unlinkSync(tmp)
    throw error
  }
}
