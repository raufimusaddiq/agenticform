import { randomBytes, randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { EnrollRequest, EnrollResponse } from "@agenticform/protocol"
import { SUPPORTED_PROTOCOL_VERSIONS, NODE_HARNESSES_MAX_COUNT, NODE_STRING_MAX_LENGTH } from "@agenticform/protocol"
import { sha256Hex } from "@agenticform/protocol/canonical"
import type { HubConfig } from "./config.ts"
import { fail, unauthorized } from "./errors.ts"
import { boundedStrings } from "./nodes.ts"
import type { NodeRow } from "./schema.ts"
import { isEd25519Spki } from "./signatures.ts"

export interface IssuedToken {
  token: string
  expiresAt: string
}

/** The secret is returned once; only its SHA-256 hash is stored (N8.3). */
export function createEnrollmentToken(db: Database, config: HubConfig, now = Date.now()): IssuedToken {
  const token = "af_enroll_" + randomBytes(32).toString("base64url")
  const expiresAt = now + config.enrollmentTtlMs
  db.query("INSERT INTO enrollment_tokens (token_hash, expires_at, created_at) VALUES (?, ?, ?)").run(
    sha256Hex(token),
    expiresAt,
    now,
  )
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

export function enrollNode(
  db: Database,
  config: HubConfig,
  body: EnrollRequest,
  now = Date.now(),
): EnrollResponse {
  if (typeof body.token !== "string" || typeof body.name !== "string" || !body.name.trim()) {
    fail("invalid_input", "token and name are required")
  }
  if (!Number.isInteger(body.protocolVersion)) {
    fail("invalid_input", "protocolVersion must be an integer")
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(body.protocolVersion)) {
    fail("version_unsupported", "protocol version is not supported")
  }
  const harnesses = boundedStrings(body.harnesses, "harnesses", NODE_HARNESSES_MAX_COUNT, NODE_STRING_MAX_LENGTH)
  if (body.labels !== undefined) {
    if (
      body.labels === null ||
      typeof body.labels !== "object" ||
      Array.isArray(body.labels) ||
      Object.values(body.labels).some((value) => typeof value !== "string")
    ) {
      fail("invalid_input", "labels must be a flat string map")
    }
  }
  if (typeof body.publicKey !== "string" || !isEd25519Spki(body.publicKey)) {
    fail("invalid_input", "publicKey must be an Ed25519 SPKI key")
  }

  const tokenHash = sha256Hex(body.token)
  const nodeId = randomUUID()
  const consume = db.transaction((): NodeRow | null => {
    const row = db
      .query<{ consumed_at: number | null; expires_at: number }, [string]>(
        "SELECT consumed_at, expires_at FROM enrollment_tokens WHERE token_hash = ?",
      )
      .get(tokenHash)
    if (!row || row.consumed_at !== null || row.expires_at <= now) return null
    const consumed = db
      .query(
        "UPDATE enrollment_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
      )
      .run(now, tokenHash, now)
    if (consumed.changes !== 1) return null
    db.query(
      `INSERT INTO nodes (id, name, public_key, status, protocol_version, harnesses, labels, last_heartbeat_at, created_at)
       VALUES (?, ?, ?, 'online', ?, ?, ?, ?, ?)`,
    ).run(
      nodeId,
      body.name,
      body.publicKey,
      body.protocolVersion,
      JSON.stringify(harnesses),
      JSON.stringify(body.labels ?? {}),
      now,
      now,
    )
    return db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(nodeId)
  })

  const node = consume()
  if (!node) unauthorized()
  return {
    nodeId: node.id,
    protocolVersion: node.protocol_version,
    heartbeatSeconds: Math.round(config.heartbeatIntervalMs / 1000),
  }
}
