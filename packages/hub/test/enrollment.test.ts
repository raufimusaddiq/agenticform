import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { sha256Hex } from "@agenticform/protocol/canonical"
import { api, enroll, startHub } from "./helpers.ts"
import type { Hub } from "../src/index.ts"

let hub: Hub | undefined
afterEach(() => {
  hub?.stop()
  hub = undefined
})

describe("enrollment", () => {
  test("one token enrolls one node and is stored only as a hash", async () => {
    hub = startHub()
    const issued = await api(hub, "POST", "/v1/enrollment-tokens")
    expect(issued.status).toBe(201)
    expect(issued.body.token.startsWith("af_enroll_")).toBe(true)

    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64")
    const response = await api(hub, "POST", "/v1/enroll", {
      token: issued.body.token,
      name: "builder-1",
      publicKey: publicKeyB64,
      protocolVersion: 1,
      harnesses: ["codex"],
    })
    expect(response.status).toBe(201)
    expect(response.body.protocolVersion).toBe(1)

    const row = hub.db
      .query<{ token_hash: string; consumed_at: number | null }, [string]>(
        "SELECT token_hash, consumed_at FROM enrollment_tokens WHERE token_hash = ?",
      )
      .get(sha256Hex(issued.body.token))
    expect(row?.token_hash).toBe(sha256Hex(issued.body.token))
    expect(row?.consumed_at).not.toBeNull()
    expect(JSON.stringify(row)).not.toContain(issued.body.token)
    void privateKey
  })

  test("reuse, expiry and a race are rejected with the same generic error", async () => {
    hub = startHub()
    const issued = await api(hub, "POST", "/v1/enrollment-tokens")
    const { publicKey } = generateKeyPairSync("ed25519")
    const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64")
    const body = {
      token: issued.body.token,
      name: "n",
      publicKey: publicKeyB64,
      protocolVersion: 1,
      harnesses: ["codex"],
    }

    const [first, second] = await Promise.all([
      api(hub, "POST", "/v1/enroll", body),
      api(hub, "POST", "/v1/enroll", body),
    ])
    expect([first.status, second.status].sort()).toEqual([201, 401])
    const reuse = await api(hub, "POST", "/v1/enroll", body)
    expect(reuse.status).toBe(401)
    expect(reuse.body).toEqual({ error: { code: "unauthorized", message: "unauthorized" } })

    const expired = await api(hub, "POST", "/v1/enrollment-tokens")
    hub.db
      .query("UPDATE enrollment_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(Date.now() - 1, sha256Hex(expired.body.token))
    const late = await api(hub, "POST", "/v1/enroll", { ...body, token: expired.body.token })
    expect(late.status).toBe(401)
    expect(late.body).toEqual({ error: { code: "unauthorized", message: "unauthorized" } })
  })

  test("a non-Ed25519 public key is refused", async () => {
    hub = startHub()
    const issued = await api(hub, "POST", "/v1/enrollment-tokens")
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const response = await api(hub, "POST", "/v1/enroll", {
      token: issued.body.token,
      name: "n",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      protocolVersion: 1,
      harnesses: ["codex"],
    })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe("invalid_input")
  })

  test("an enrolled node can heartbeat", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const response = await api(hub, "GET", "/v1/nodes")
    expect(response.body.nodes).toHaveLength(1)
    expect(response.body.nodes[0].nodeId).toBe(node.nodeId)
  })
})
