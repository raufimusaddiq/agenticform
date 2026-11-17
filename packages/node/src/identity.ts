import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { generateKeyPairSync } from "node:crypto"
import { join } from "node:path"

export interface KeyPair {
  publicKeyB64: string
  privateKeyPem: string
}

export interface NodeIdentity extends KeyPair {
  nodeId: string
  hubUrl: string
}

/** Generated locally; only the public key ever leaves the machine (FR-012). */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKeyB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  }
}

export const identityDir = (stateDir: string): string => join(stateDir, "identity")
export const privateKeyPath = (stateDir: string): string => join(identityDir(stateDir), "device.pem")
export const identityPath = (stateDir: string): string => join(identityDir(stateDir), "node.json")

/** Missing or unreadable identity is no identity; enrollment is retried, never guessed. */
export function loadIdentity(stateDir: string): NodeIdentity | null {
  try {
    const meta = JSON.parse(readFileSync(identityPath(stateDir), "utf8")) as {
      nodeId?: unknown
      publicKeyB64?: unknown
      hubUrl?: unknown
    }
    if (typeof meta.nodeId !== "string" || typeof meta.publicKeyB64 !== "string") return null
    return {
      nodeId: meta.nodeId,
      publicKeyB64: meta.publicKeyB64,
      hubUrl: typeof meta.hubUrl === "string" ? meta.hubUrl : "",
      privateKeyPem: readFileSync(privateKeyPath(stateDir), "utf8"),
    }
  } catch {
    return null
  }
}

/** Private key and metadata are mode 0600 (FR-012). */
export function saveIdentity(stateDir: string, identity: NodeIdentity): void {
  const dir = identityDir(stateDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const keyPath = privateKeyPath(stateDir)
  writeFileSync(keyPath, identity.privateKeyPem, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  const metaPath = identityPath(stateDir)
  const meta = { nodeId: identity.nodeId, publicKeyB64: identity.publicKeyB64, hubUrl: identity.hubUrl }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 })
  chmodSync(metaPath, 0o600)
}
