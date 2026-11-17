import { createHash, timingSafeEqual } from "node:crypto"
import type { Database } from "bun:sqlite"
import type {
  CompletionRequest,
  EnrollRequest,
  EventBatch,
  HeartbeatRequest,
  RunRequest,
} from "@agenticform/protocol"
import { completeCommand, leaseNext, renewLease } from "./commands.ts"
import type { HubConfig } from "./config.ts"
import { createEnrollmentToken, enrollNode } from "./enrollment.ts"
import { HubError, fail } from "./errors.ts"
import { appendEvents, listEvents } from "./events.ts"
import { heartbeat, listNodes, setNodeStatus, sweepHealth } from "./nodes.ts"
import { cleanupNonces } from "./nonces.ts"
import { cancelRun, createRun, getRun, recoverRun, runView } from "./runs.ts"
import { openDatabase } from "./schema.ts"
import { authenticateMachine } from "./signatures.ts"
import { validateConfig } from "./config.ts"

export interface Hub {
  server: ReturnType<typeof Bun.serve>
  db: Database
  config: HubConfig
  url: string
  stop(): void
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const empty = (status: number): Response => new Response(null, { status })

async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text()
  if (!text) fail("invalid_input", "a JSON body is required")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail("invalid_input", "body is not valid JSON")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_input", "body must be a JSON object")
  }
  return value as T
}

function parseBody(raw: Uint8Array): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    fail("invalid_input", "body is not valid JSON")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_input", "body must be a JSON object")
  }
  return value as Record<string, unknown>
}

function requireBody(body: unknown): Record<string, unknown> {
  if (body === undefined) fail("invalid_input", "a JSON body is required")
  return body as Record<string, unknown>
}

/** Constant-time bearer compare with no anonymous fallback (N8.1). */
function authenticateBearer(config: HubConfig, headers: Headers): void {
  if (config.adminToken.length < 32) fail("unauthorized", "unauthorized")
  const header = headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
  const given = createHash("sha256").update(token).digest()
  const expected = createHash("sha256").update(config.adminToken).digest()
  if (!timingSafeEqual(given, expected)) fail("unauthorized", "unauthorized")
}

export function createHub(config: HubConfig): Hub {
  validateConfig(config)
  const db = openDatabase(config.stateFile)

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname
    try {
      if (request.method === "GET" && path === "/health") return json({ status: "ok" })

      if (request.method === "POST" && path === "/v1/enroll") {
        return json(enrollNode(db, config, await readJson<EnrollRequest>(request)), 201)
      }

      if (path.startsWith("/v1/node/")) return await machine(request, url)

      authenticateBearer(config, request.headers)

      if (request.method === "POST" && path === "/v1/enrollment-tokens") {
        return json(createEnrollmentToken(db, config), 201)
      }
      if (request.method === "GET" && path === "/v1/nodes") {
        return json({ nodes: listNodes(db) })
      }
      const nodeAction = /^\/v1\/nodes\/([^/]+)\/(disable|revoke)$/.exec(path)
      if (request.method === "POST" && nodeAction) {
        const [, nodeId, action] = nodeAction
        return json(setNodeStatus(db, nodeId as string, action === "disable" ? "disabled" : "revoked"))
      }
      if (request.method === "POST" && path === "/v1/runs") {
        const result = createRun(db, await readJson<RunRequest>(request))
        return json(runView(db, result.run), result.created ? 201 : 200)
      }
      const runAction = /^\/v1\/runs\/([^/]+)(?:\/(events|cancel|recover))?$/.exec(path)
      if (runAction) {
        const runId = runAction[1] as string
        const action = runAction[2]
        if (request.method === "GET" && action === undefined) {
          return json(runView(db, getRun(db, runId)))
        }
        if (request.method === "GET" && action === "events") {
          getRun(db, runId)
          const after = Number(url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? 0)
          if (url.searchParams.get("stream") === "sse") {
            return sse(db, runId, Number.isFinite(after) ? after : 0, request.signal)
          }
          const events = listEvents(db, runId, Number.isFinite(after) ? after : 0)
          return json({ events, lastSeq: events.at(-1)?.seq ?? after })
        }
        if (request.method === "POST" && action === "cancel") {
          const result = cancelRun(db, runId)
          return json(runView(db, result.run), result.queued ? 202 : 200)
        }
        if (request.method === "POST" && action === "recover") {
          return json(runView(db, recoverRun(db, config, runId)))
        }
      }
      fail("not_found", "route not found")
    } catch (error) {
      if (error instanceof HubError) {
        return json({ error: { code: error.code, message: error.message } }, error.status)
      }
      console.error("hub internal error:", error instanceof Error ? error.message : "unknown")
      return json({ error: { code: "internal", message: "internal" } }, 500)
    }
  }

  const machine = async (request: Request, url: URL): Promise<Response> => {
    const raw = new Uint8Array(await request.arrayBuffer())
    const node = authenticateMachine(db, config, {
      method: request.method,
      path: url.pathname + url.search,
      headers: request.headers,
      body: raw,
    })
    const body = raw.length ? parseBody(raw) : undefined

    if (request.method === "POST" && url.pathname === "/v1/node/heartbeat") {
      return json(heartbeat(db, config, node, requireBody(body) as unknown as HeartbeatRequest))
    }
    if (request.method === "GET" && url.pathname === "/v1/node/commands/next") {
      const command = leaseNext(db, config, node)
      return command ? json(command) : empty(204)
    }
    const action = /^\/v1\/node\/commands\/([^/]+)\/(renew|events|complete)$/.exec(url.pathname)
    if (request.method === "POST" && action) {
      const commandId = action[1] as string
      if (action[2] === "renew") return json(renewLease(db, config, node, commandId))
      if (action[2] === "events") {
        return json(appendEvents(db, node.id, commandId, requireBody(body) as unknown as EventBatch))
      }
      return json(completeCommand(db, node, commandId, requireBody(body) as unknown as CompletionRequest))
    }
    fail("not_found", "route not found")
  }

  const server = Bun.serve({ port: config.port, fetch: handle })

  const nonceTimer = setInterval(() => cleanupNonces(db), config.nonceCleanupMs)
  const healthTimer = setInterval(
    () => sweepHealth(db, config),
    Math.max(1_000, Math.min(config.heartbeatIntervalMs, config.nodeOfflineMs)),
  )

  return {
    server,
    db,
    config,
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      clearInterval(nonceTimer)
      clearInterval(healthTimer)
      server.stop(true)
      db.close()
    },
  }
}

/** SSE replay from `after`, ending after the terminal event (FR-020). */
function sse(db: Database, runId: string, after: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let cursor = after
      let idle = 0
      const close = () => {
        try {
          controller.close()
        } catch {
          // The client may already have cancelled the stream.
        }
      }
      try {
        controller.enqueue(encoder.encode(": connected\n\n"))
        while (!signal.aborted) {
          const events = listEvents(db, runId, cursor)
          for (const event of events) {
            if (signal.aborted) return close()
            cursor = event.seq
            controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`))
            if (event.type === "run.finished" || event.type === "run.disconnected") return close()
          }
          const run = getRun(db, runId)
          if (["completed", "failed", "cancelled", "disconnected"].includes(run.status) && events.length === 0) {
            return close()
          }
          idle += 1
          if (idle % 20 === 0) controller.enqueue(encoder.encode(": keepalive\n\n"))
          await Bun.sleep(250)
        }
        close()
      } catch {
        close()
      }
    },
    cancel() {},
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}
