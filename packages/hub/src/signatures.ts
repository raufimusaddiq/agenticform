import { createPublicKey, verify as verifySignature } from "node:crypto"
import type { Database } from "bun:sqlite"
import { canonicalString } from "@agenticform/protocol/canonical"
import type { HubConfig } from "./config.ts"
import { unauthorized } from "./errors.ts"
import type { NodeRow } from "./schema.ts"

const NONCE_SHAPE = /^[A-Za-z0-9._:-]{16,128}$/

export interface SignedRequest {
  method: string
  path: string
  headers: Headers
  body: Uint8Array
}

/** Only Ed25519 SPKI keys are accepted (N2.3). */
export function isEd25519Spki(publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" })
    return key.asymmetricKeyType === "ed25519"
  } catch {
    return false
  }
}

export function verifyEd25519(publicKeyB64: string, data: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" })
    if (key.asymmetricKeyType !== "ed25519") return false
    return verifySignature(null, Buffer.from(data), key, Buffer.from(signatureB64, "base64"))
  } catch {
    return false
  }
}

/**
 * Verify in the fixed order (N2.2): known and enabled node, nonce shape, clock skew,
 * signature, then nonce insert. Steps 1-4 never consume the nonce (N3.2).
 */
export function authenticateMachine(
  db: Database,
  config: HubConfig,
  request: SignedRequest,
  now = Date.now(),
): NodeRow {
  const nodeId = request.headers.get("x-af-node-id") ?? ""
  const timestamp = Number(request.headers.get("x-af-timestamp"))
  const nonce = request.headers.get("x-af-nonce") ?? ""
  const signature = request.headers.get("x-af-signature") ?? ""

  const node = nodeId
    ? db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(nodeId)
    : null
  if (!node || node.status === "revoked" || node.status === "disabled") unauthorized()
  if (!NONCE_SHAPE.test(nonce)) unauthorized()
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > config.clockSkewMs) unauthorized()

  const canonical = canonicalString({
    nodeId: node.id,
    timestampMs: timestamp,
    nonce,
    method: request.method,
    path: request.path,
    body: request.body,
  })
  if (!verifyEd25519(node.public_key, canonical, signature)) unauthorized()

  const expiresAt = now + config.nonceTtlMs
  if (expiresAt <= now) unauthorized()
  const inserted = db
    .query("INSERT INTO request_nonces (node_id, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
    .run(node.id, nonce, expiresAt)
  if (inserted.changes !== 1) unauthorized()
  return node
}
