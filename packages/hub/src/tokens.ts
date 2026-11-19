import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { CallerTokenView, IssuedCallerToken } from "@agenticform/protocol"
import { fail } from "./errors.ts"
import type { CallerTokenRow } from "./schema.ts"

/** Who a bearer token is. A `runs` token is a caller, never an operator. */
export type Principal = { kind: "admin" } | { kind: "runs"; tokenId: string }

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
const ID_LENGTH = 12
const NAME_MAX_LENGTH = 64
const LAST_USED_INTERVAL_MS = 60_000
const TOKEN_PATTERN = /^afc_([a-z2-7]{12})_(.+)$/

const digest = (token: string): string => createHash("sha256").update(token).digest("hex")

/** 12 base32 characters; 256 is a multiple of 32, so the modulo is unbiased. */
function randomId(): string {
  let id = ""
  for (const byte of randomBytes(ID_LENGTH)) id += ID_ALPHABET[byte % ID_ALPHABET.length]
  return id
}

function view(row: CallerTokenRow): CallerTokenView {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  }
}

function get(db: Database, id: string): CallerTokenRow | null {
  return db.query<CallerTokenRow, [string]>("SELECT * FROM caller_tokens WHERE id = ?").get(id)
}

/** Issue a `runs` token. The secret is returned here and nowhere else (R1). */
export function issueToken(
  db: Database,
  name: unknown,
  scope: unknown,
  now = Date.now(),
): IssuedCallerToken {
  if (typeof name !== "string" || name.length < 1 || name.length > NAME_MAX_LENGTH) {
    fail("invalid_input", `name must be 1 to ${NAME_MAX_LENGTH} characters`)
  }
  if (scope !== "runs") fail("invalid_input", "scope must be runs")
  const taken = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM caller_tokens WHERE name = ? AND revoked_at IS NULL",
    )
    .get(name)
  if (taken) fail("name_taken", "an active token already uses that name")

  const id = randomId()
  const token = `afc_${id}_${randomBytes(32).toString("base64url")}`
  db.query(
    `INSERT INTO caller_tokens (id, name, scope, digest, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(id, name, scope, digest(token), now)
  return { ...view(get(db, id) as CallerTokenRow), token }
}

export function listTokens(db: Database): CallerTokenView[] {
  return db
    .query<CallerTokenRow, []>("SELECT * FROM caller_tokens ORDER BY created_at, id")
    .all()
    .map(view)
}

/** Revoking twice returns the same row, so the call is idempotent. */
export function revokeToken(db: Database, id: string, now = Date.now()): CallerTokenView {
  const row = get(db, id)
  if (!row) fail("not_found", "token not found")
  if (row.revoked_at === null) {
    db.query("UPDATE caller_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id)
  }
  return view(get(db, id) as CallerTokenRow)
}

/**
 * Authenticate `afc_<id>_<secret>`: indexed lookup by id, constant-time digest
 * compare, revoked rows refused. `last_used_at` is written at most once a
 * minute so reads do not become writes.
 */
export function authenticateToken(db: Database, token: string, now = Date.now()): Principal | null {
  const match = TOKEN_PATTERN.exec(token)
  if (!match) return null
  const row = get(db, match[1] as string)
  if (!row || row.revoked_at !== null) return null
  const given = Buffer.from(digest(token), "hex")
  const expected = Buffer.from(row.digest, "hex")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_INTERVAL_MS) {
    db.query("UPDATE caller_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id)
  }
  return { kind: "runs", tokenId: row.id }
}
