import { createHash } from "node:crypto"

/** Lower-case hex SHA-256 of the raw bytes. An empty body hashes the empty byte array. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex")
}

export interface CanonicalInput {
  nodeId: string
  timestampMs: number | string
  nonce: string
  method: string
  path: string
  body: Uint8Array | string
}

/**
 * The exact bytes an Ed25519 node signature covers (N2.1):
 * nodeId, timestampMs, nonce, upper-case method, exact path, hex SHA-256 of the body.
 */
export function canonicalString(input: CanonicalInput): string {
  return [
    input.nodeId,
    String(input.timestampMs),
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    sha256Hex(input.body),
  ].join("\n")
}

/**
 * Command fingerprint (N5.3). `payloadJson` is the exact payload bytes without the
 * `fingerprint` field, so the value is not self-referential.
 */
export function commandFingerprint(
  type: string,
  idempotencyKey: string,
  generation: number,
  payloadJson: string,
): string {
  return "sha256:" + sha256Hex(type + idempotencyKey + String(generation) + payloadJson)
}
