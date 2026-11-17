import { afterEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
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

describe("protocol version", () => {
  test("an unsupported version is stored but never leased a command", async () => {
    hub = startHub()
    const node = await enroll(hub, { protocolVersion: 2 })
    await heartbeat(hub, node, { protocolVersion: 2 })
    const run = await api(hub, "POST", "/v1/runs", {
      idempotencyKey: "v2-run",
      harness: "codex",
      prompt: "go",
    })
    expect(run.status).toBe(422)
    expect(run.body.error.code).toBe("no_eligible_node")

    const pinned = await api(hub, "POST", "/v1/runs", {
      idempotencyKey: "v2-pinned",
      harness: "codex",
      prompt: "go",
      nodeId: node.nodeId,
    })
    expect(pinned.status).toBe(409)
    expect(pinned.body.error.code).toBe("version_unsupported")

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
