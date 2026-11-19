import { describe, expect, test } from "bun:test"
import type { Hub } from "../src/index.ts"
import { insertEvent } from "../src/events.ts"
import { authenticateToken, issueToken } from "../src/tokens.ts"
import { api, enroll, heartbeat, startHub } from "./helpers.ts"

interface Issued {
  id: string
  name: string
  scope: string
  token: string
}

async function issue(hub: Hub, name = "ci-agent"): Promise<Issued> {
  const response = await api(hub, "POST", "/v1/tokens", { name, scope: "runs" })
  expect(response.status).toBe(201)
  return response.body as Issued
}

/** An online node and one queued run, so every caller route has an id to use. */
async function onlineRun(hub: Hub): Promise<{ nodeId: string; runId: string }> {
  const node = await enroll(hub)
  const beat = await heartbeat(hub, node)
  expect(beat.status).toBe(200)
  const run = await api(hub, "POST", "/v1/runs", {
    idempotencyKey: "route-1",
    harness: "codex",
    prompt: "fix tests",
    nodeId: node.nodeId,
  })
  expect(run.status).toBe(201)
  return { nodeId: node.nodeId, runId: run.body.runId as string }
}

describe("caller token route table (T005)", () => {
  test("a runs token may use the caller routes and nothing else", async () => {
    const hub = startHub()
    try {
      const node = await enroll(hub)
      expect((await heartbeat(hub, node)).status).toBe(200)
      const issued = await issue(hub)
      const asRuns = issued.token

      // Allowed: submit, read, follow, cancel, list nodes.
      const created = await api(hub, "POST", "/v1/runs", {
        idempotencyKey: "runs-submit",
        harness: "codex",
        prompt: "p",
        nodeId: node.nodeId,
      }, asRuns)
      expect(created.status).toBe(201)
      const runId = created.body.runId as string
      for (const [method, path] of [
        ["GET", `/v1/runs/${runId}`],
        ["GET", `/v1/runs/${runId}/events`],
        ["POST", `/v1/runs/${runId}/cancel`],
        ["GET", "/v1/nodes"],
      ] as const) {
        const response = await api(hub, method, path, undefined, asRuns)
        expect(response.status).not.toBe(401)
        expect(response.status).not.toBe(403)
      }

      // Refused: every owner-only route, with no state change.
      const tokenRows = () => (api(hub, "GET", "/v1/tokens").then((r) => r.body.tokens.length)) as Promise<number>
      const tokensBefore = await tokenRows()
      for (const [method, path] of [
        ["POST", "/v1/enrollment-tokens"],
        ["POST", `/v1/nodes/${node.nodeId}/disable`],
        ["POST", `/v1/nodes/${node.nodeId}/revoke`],
        ["POST", `/v1/runs/${runId}/recover`],
        ["POST", "/v1/tokens"],
        ["POST", `/v1/tokens/${issued.id}/revoke`],
      ] as const) {
        const response = await api(hub, method, path, method === "POST" && path === "/v1/tokens"
          ? { name: "sneaky", scope: "runs" }
          : undefined, asRuns)
        expect(response.status).toBe(403)
        expect(response.body.error.code).toBe("forbidden")
      }
      expect(await tokenRows()).toBe(tokensBefore)
      const nodes = await api(hub, "GET", "/v1/nodes")
      expect(nodes.body.nodes[0].status).toBe("online")

      // A route missing from the table is admin-only.
      expect((await api(hub, "GET", "/v1/unknown")).status).toBe(404)
      expect((await api(hub, "GET", "/v1/unknown", undefined, asRuns)).status).toBe(403)

      // A revoked token, and no token, are 401.
      await api(hub, "POST", `/v1/tokens/${issued.id}/revoke`)
      expect((await api(hub, "GET", "/v1/nodes", undefined, asRuns)).status).toBe(401)
      expect((await api(hub, "GET", "/v1/nodes", undefined, "")).status).toBe(401)
      expect((await fetch(`${hub.url}/v1/nodes`)).status).toBe(401)
    } finally {
      hub.stop()
    }
  })
})

describe("caller token lifecycle (T006)", () => {
  test("the secret appears once and never in a list", async () => {
    const hub = startHub()
    try {
      const issued = await issue(hub, "first")
      expect(issued.token).toMatch(/^afc_[a-z2-7]{12}_[\w-]+$/)
      expect(issued.id).toHaveLength(12)
      expect(issued.scope).toBe("runs")

      const listed = await api(hub, "GET", "/v1/tokens")
      expect(listed.status).toBe(200)
      expect(listed.body.tokens).toHaveLength(1)
      expect(listed.body.tokens[0]).not.toHaveProperty("token")
      expect(listed.body.tokens[0]).not.toHaveProperty("digest")
      expect(JSON.stringify(listed.body)).not.toContain(issued.token.replace(/^afc_[a-z2-7]{12}_/, ""))
    } finally {
      hub.stop()
    }
  })

  test("a name is bounded and unique among active tokens, and the scope is runs only", async () => {
    const hub = startHub()
    try {
      await issue(hub, "name-1")
      const dup = await api(hub, "POST", "/v1/tokens", { name: "name-1", scope: "runs" })
      expect(dup.status).toBe(409)
      expect(dup.body.error.code).toBe("name_taken")

      expect((await api(hub, "POST", "/v1/tokens", { name: "", scope: "runs" })).status).toBe(400)
      expect((await api(hub, "POST", "/v1/tokens", { name: "x".repeat(65), scope: "runs" })).status).toBe(400)
      const scope = await api(hub, "POST", "/v1/tokens", { name: "admin-1", scope: "admin" })
      expect(scope.status).toBe(400)
      expect(scope.body.error.code).toBe("invalid_input")

      // A revoked name may be reused.
      const first = await issue(hub, "reuse")
      await api(hub, "POST", `/v1/tokens/${first.id}/revoke`)
      expect((await api(hub, "POST", "/v1/tokens", { name: "reuse", scope: "runs" })).status).toBe(201)
    } finally {
      hub.stop()
    }
  })

  test("revoke is idempotent", async () => {
    const hub = startHub()
    try {
      const issued = await issue(hub, "revoke-me")
      const once = await api(hub, "POST", `/v1/tokens/${issued.id}/revoke`)
      expect(once.status).toBe(200)
      expect(once.body.revokedAt).toBeTruthy()
      const twice = await api(hub, "POST", `/v1/tokens/${issued.id}/revoke`)
      expect(twice.status).toBe(200)
      expect(twice.body).toEqual(once.body)
      expect((await api(hub, "POST", "/v1/tokens/nope/revoke")).status).toBe(404)
    } finally {
      hub.stop()
    }
  })

  test("last_used_at is written at most once a minute", () => {
    const hub = startHub()
    try {
      const db = hub.db
      const issued = issueToken(db, "unit", "runs", 1_000_000)
      const lastUsed = (): number | null =>
        (db.query<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM caller_tokens WHERE id = ?",
        ).get(issued.id) as { last_used_at: number | null }).last_used_at

      expect(lastUsed()).toBeNull()
      expect(authenticateToken(db, issued.token, 1_000_000)).toEqual({ kind: "runs", tokenId: issued.id })
      expect(lastUsed()).toBe(1_000_000)
      expect(authenticateToken(db, issued.token, 1_030_000)).not.toBeNull()
      expect(lastUsed()).toBe(1_000_000)
      expect(authenticateToken(db, issued.token, 1_060_000)).not.toBeNull()
      expect(lastUsed()).toBe(1_060_000)

      // A wrong secret with a real id is refused.
      expect(authenticateToken(db, `afc_${issued.id}_wrong`, 2_000_000)).toBeNull()
      expect(authenticateToken(db, "not-a-token", 2_000_000)).toBeNull()
    } finally {
      hub.stop()
    }
  })
})

describe("follow under revocation (T007)", () => {
  test("an open SSE follow ends with an unauthorized error within 30 s", async () => {
    const hub = startHub()
    const controller = new AbortController()
    try {
      const { runId } = await onlineRun(hub)
      const issued = await issue(hub, "follow-token")
      const response = await fetch(`${hub.url}/v1/runs/${runId}/events?stream=sse`, {
        headers: { authorization: `Bearer ${issued.token}`, accept: "text/event-stream" },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const started = Date.now()
      let text = ""
      const reading = (async () => {
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          text += decoder.decode(value, { stream: true })
          if (text.includes('"code":"unauthorized"')) return
        }
      })()
      await Bun.sleep(200)
      expect((await api(hub, "POST", `/v1/tokens/${issued.id}/revoke`)).status).toBe(200)
      await reading
      expect(text).toContain("event: error")
      expect(text).toContain('"code":"unauthorized"')
      expect(Date.now() - started).toBeLessThan(30_000)
    } finally {
      controller.abort()
      hub.stop()
    }
  }, 20_000)

  test("a busy run still loses its stream within 30 s of revocation", async () => {
    const hub = startHub()
    const controller = new AbortController()
    let appending: ReturnType<typeof setInterval> | undefined
    try {
      const { runId } = await onlineRun(hub)
      const issued = await issue(hub, "busy-follow")
      const response = await fetch(`${hub.url}/v1/runs/${runId}/events?stream=sse`, {
        headers: { authorization: `Bearer ${issued.token}`, accept: "text/event-stream" },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const started = Date.now()
      let text = ""
      let seq = 0
      // Events every second: the idle counter never reaches a keepalive.
      appending = setInterval(() => {
        seq += 1
        insertEvent(hub.db, runId, {
          key: `busy:${seq}`,
          type: "message.delta",
          at: new Date().toISOString(),
          data: { seq },
        })
      }, 1_000)
      const reading = (async () => {
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          text += decoder.decode(value, { stream: true })
          if (text.includes('"code":"unauthorized"')) return
        }
      })()
      await Bun.sleep(1_200)
      expect((await api(hub, "POST", `/v1/tokens/${issued.id}/revoke`)).status).toBe(200)
      await reading
      clearInterval(appending)
      appending = undefined

      expect(text).toContain("message.delta")
      expect(text).toContain("event: error")
      expect(text).toContain('"code":"unauthorized"')
      expect(Date.now() - started).toBeLessThan(30_000)
      // Nothing follows the error frame.
      const marker = '"code":"unauthorized"'
      expect(text.slice(text.indexOf(marker) + marker.length)).not.toContain("data:")
    } finally {
      if (appending !== undefined) clearInterval(appending)
      controller.abort()
      hub.stop()
    }
  }, 20_000)
})

describe("token secrets (T008)", () => {
  test("a secret reaches no event row, log line or UI asset", async () => {
    const hub = startHub()
    const lines: string[] = []
    const originalError = console.error
    const originalLog = console.log
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    }
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    }
    try {
      const issued = await issue(hub, "secret-token")
      const secret = issued.token.replace(/^afc_[a-z2-7]{12}_/, "")
      const { runId } = await onlineRun(hub)

      await api(hub, "GET", `/v1/runs/${runId}`, undefined, issued.token)
      await api(hub, "POST", `/v1/runs/${runId}/cancel`)
      await api(hub, "GET", "/v1/tokens")

      const events = await api(hub, "GET", `/v1/runs/${runId}/events`)
      expect(JSON.stringify(events.body)).not.toContain(secret)
      const rows = hub.db.query("SELECT data_json FROM run_events").all()
      expect(JSON.stringify(rows)).not.toContain(secret)
      expect(lines.join("\n")).not.toContain(secret)
      for (const path of ["/", "/ui/app.js", "/ui/app.css"]) {
        expect(await (await fetch(hub.url + path)).text()).not.toContain(secret)
      }
    } finally {
      console.error = originalError
      console.log = originalLog
      hub.stop()
    }
  })
})
