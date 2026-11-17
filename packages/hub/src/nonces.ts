import type { Database } from "bun:sqlite"

/** Delete nonce rows at or past expiry (N3.3). Returns the number removed. */
export function cleanupNonces(db: Database, now = Date.now()): number {
  return db.query("DELETE FROM request_nonces WHERE expires_at <= ?").run(now).changes
}
