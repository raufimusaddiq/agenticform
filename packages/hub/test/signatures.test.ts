import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { cleanupNonces } from "../src/index.ts"
import type { Hub } from "../src/index.ts"
import { api, enroll, heartbeat, signedFetch, startHub } from "./helpers.ts"

let hub: Hub | undefined
afterEach(() => {
  hub?.stop()
  hub = undefined
})

const generated = () => randomBytes(8).toString("hex")

describe("signed requests", () => {
  test("a valid request consumes its nonce and replay is rejected", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const nonce = generated()
    const body = { protocolVersion: 1, harnesses: ["codex"] }
    const first = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", body, { nonce })
    expect(first.status).toBe(200)
    const replay = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", body, { nonce })
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: { code: "unauthorized", message: "unauthorized" } })
  })

  test("a bad signature does not burn the nonce", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const nonce = generated()
    const body = { protocolVersion: 1, harnesses: ["codex"] }
    const bad = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", body, {
      nonce,
      signature: Buffer.from("nope").toString("base64"),
    })
    expect(bad.status).toBe(401)
    const good = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", body, { nonce })
    expect(good.status).toBe(200)
  })

  test("an unknown node and a skewed timestamp are indistinguishable", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const unknown = { ...node, nodeId: "00000000-0000-4000-8000-000000000000" }
    const first = await signedFetch(hub, unknown, "POST", "/v1/node/heartbeat", { protocolVersion: 1, harnesses: [] })
    const second = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", { protocolVersion: 1, harnesses: [] }, {
      timestamp: Date.now() - 60 * 60 * 1000,
    })
    expect(first.status).toBe(401)
    expect(second.status).toBe(401)
    expect(await first.json()).toEqual(await second.json())
  })

  test("a disabled node can no longer authenticate", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const disabled = await api(hub, "POST", `/v1/nodes/${node.nodeId}/disable`)
    expect(disabled.status).toBe(200)
    expect(disabled.body.status).toBe("disabled")
    const response = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", { protocolVersion: 1, harnesses: ["codex"] })
    expect(response.status).toBe(401)
  })

  test("a malformed nonce is refused before the signature", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const response = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", { protocolVersion: 1, harnesses: [] }, {
      nonce: "short",
    })
    expect(response.status).toBe(401)
  })

  test("an undecodable stored key fails closed with the generic error", async () => {
    hub = startHub()
    const node = await enroll(hub)
    hub.db.query("UPDATE nodes SET public_key = 'not-a-key' WHERE id = ?").run(node.nodeId)
    const response = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", { protocolVersion: 1, harnesses: [] })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "unauthorized" } })
  })
})

describe("nonce cleanup", () => {
  test("deletes rows at or past expiry and keeps live rows", () => {
    hub = startHub()
    const now = Date.now()
    hub.db
      .query("INSERT INTO request_nonces (node_id, nonce, expires_at) VALUES (?, ?, ?)")
      .run("n", "expired-nonce-123456", now)
    hub.db
      .query("INSERT INTO request_nonces (node_id, nonce, expires_at) VALUES (?, ?, ?)")
      .run("n", "live-nonce-12345678", now + 1_000)
    expect(cleanupNonces(hub.db, now)).toBe(1)
    const rows = hub.db.query<{ nonce: string }, []>("SELECT nonce FROM request_nonces").all()
    expect(rows.map((row) => row.nonce)).toEqual(["live-nonce-12345678"])
  })
})

describe("heartbeat validation", () => {
  test("capacity must be non-negative integers", async () => {
    hub = startHub()
    const node = await enroll(hub)
    for (const capacity of [
      { slots: -1, inUse: 0 },
      { slots: 1, inUse: -1 },
      { slots: 1.5, inUse: 0 },
      { slots: "1", inUse: 0 },
    ]) {
      const response = await heartbeat(hub, node, { capacity })
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe("invalid_input")
    }
  })

  test("harnesses and capabilities must be string arrays", async () => {
    hub = startHub()
    const node = await enroll(hub)
    for (const body of [{ harnesses: [1] }, { capabilities: [{}] }]) {
      const response = await heartbeat(hub, node, body)
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe("invalid_input")
    }
  })

  test("machine routes reject missing or non-object JSON bodies", async () => {
    hub = startHub()
    const node = await enroll(hub)
    for (const body of [null, [], "x", 3]) {
      const response = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", body)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_input")
    }
    const missing = await signedFetch(hub, node, "POST", "/v1/node/heartbeat")
    expect(missing.status).toBe(400)
  })

  test("oversized machine bodies are rejected before auth", async () => {
    hub = startHub({ maxBodyBytes: 2048 })
    const node = await enroll(hub)
    const response = await signedFetch(hub, node, "POST", "/v1/node/heartbeat", {
      protocolVersion: 1,
      harnesses: [],
      pad: "x".repeat(4000),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: { code: "payload_too_large", message: "request body is too large" },
    })
  })
})

describe("protocol version", () => {
  test("enrollment refuses an unsupported version", async () => {
    hub = startHub()
    const issued = await api(hub, "POST", "/v1/enrollment-tokens")
    const { publicKey } = generateKeyPairSync("ed25519")
    const response = await api(hub, "POST", "/v1/enroll", {
      token: issued.body.token,
      name: "v2",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      protocolVersion: 2,
      harnesses: ["codex"],
    })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe("version_unsupported")
    expect(hub.db.query("SELECT COUNT(*) AS n FROM nodes").get()).toEqual({ n: 0 })
  })

  test("heartbeat refuses an unsupported version", async () => {
    hub = startHub()
    const node = await enroll(hub)
    const response = await heartbeat(hub, node, { protocolVersion: 2 })
    expect(response.status).toBe(409)
    expect(response.body.error).toEqual({
      code: "version_unsupported",
      message: "protocol version is not supported",
    })
  })

  test("an unsupported stored version is never leased a command", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    hub.db.query("UPDATE nodes SET protocol_version = 2 WHERE id = ?").run(node.nodeId)
    hub.db
      .query(
        "INSERT INTO commands (id, run_id, node_id, type, idempotency_key, generation, payload_json, fingerprint, status, created_at, updated_at) VALUES ('c1','r1',?,'run.start','k',1,'{}','sha256:x','queued',0,0)",
      )
      .run(node.nodeId)
    const polled = await signedFetch(hub, node, "GET", "/v1/node/commands/next")
    expect(polled.status).toBe(409)
    expect(await polled.json()).toEqual({
      error: { code: "version_unsupported", message: "node protocol version is not supported" },
    })
  })
})
