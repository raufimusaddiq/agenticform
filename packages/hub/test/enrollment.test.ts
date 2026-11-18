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

  test("oversized enroll bodies are rejected before processing", async () => {
    hub = startHub({ maxBodyBytes: 128 })
    const response = await api(hub, "POST", "/v1/enroll", {
      token: "x".repeat(500),
      name: "n",
      publicKey: "k",
      protocolVersion: 1,
      harnesses: [],
    })
    expect(response.status).toBe(413)
    expect(response.body.error.code).toBe("payload_too_large")
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

  test("labels must be a flat string map", async () => {
    hub = startHub()
    const issued = await api(hub, "POST", "/v1/enrollment-tokens")
    const { publicKey } = generateKeyPairSync("ed25519")
    const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64")
    for (const labels of [{ a: 1 }, ["x"], "x"]) {
      const response = await api(hub, "POST", "/v1/enroll", {
        token: issued.body.token,
        name: "n",
        publicKey: publicKeyB64,
        protocolVersion: 1,
        harnesses: ["codex"],
        labels,
      })
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe("invalid_input")
    }
  })

  test("the schema indexes runs by node", () => {
    hub = startHub()
    const index = hub.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_node'")
      .get()
    expect(index?.name).toBe("runs_node")
  })
})

describe("enrollment field caps (T-34)", () => {
  const attempt = async (patch: Record<string, unknown>) => {
    const issued = await api(hub as Hub, "POST", "/v1/enrollment-tokens")
    const { publicKey } = generateKeyPairSync("ed25519")
    return api(hub as Hub, "POST", "/v1/enroll", {
      token: issued.body.token,
      name: "n",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      protocolVersion: 1,
      harnesses: ["codex"],
      ...patch,
    })
  }
  const many = (n: number, prefix: string): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

  test("name at the limit is accepted, one over is rejected", async () => {
    hub = startHub()
    expect((await attempt({ name: "n".repeat(64) })).status).toBe(201)
    const over = await attempt({ name: "n".repeat(65) })
    expect(over.status).toBe(400)
    expect(over.body.error.code).toBe("invalid_input")
  })

  test("labels at the limit are accepted, one over is rejected", async () => {
    hub = startHub()
    const labels = Object.fromEntries(many(32, "k").map((key) => [key, "v"]))
    expect((await attempt({ labels })).status).toBe(201)
    const over = await attempt({ labels: { ...labels, extra: "v" } })
    expect(over.status).toBe(400)
    expect(over.body.error.code).toBe("invalid_input")
  })

  test("label key and value at the limit are accepted, one over is rejected", async () => {
    hub = startHub()
    expect((await attempt({ labels: { ["k".repeat(64)]: "v".repeat(64) } })).status).toBe(201)
    expect((await attempt({ labels: { ["k".repeat(65)]: "v" } })).status).toBe(400)
    expect((await attempt({ labels: { k: "v".repeat(65) } })).status).toBe(400)
  })

  test("harnesses at the limit are accepted, one over is rejected", async () => {
    hub = startHub()
    expect((await attempt({ harnesses: many(32, "h") })).status).toBe(201)
    expect((await attempt({ harnesses: many(33, "h") })).status).toBe(400)
    expect((await attempt({ harnesses: ["x".repeat(64)] })).status).toBe(201)
    expect((await attempt({ harnesses: ["x".repeat(65)] })).status).toBe(400)
  })
})
