import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"

const bin = join(import.meta.dir, "..", "bin", "mcp.ts")
const encoder = new TextEncoder()
let staleStreams = 0

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/v1/runs/r1/events") {
      const after = Number(url.searchParams.get("after") ?? 0)
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let seq = after + 1; seq <= 1_500; seq++) {
              controller.enqueue(
                encoder.encode(
                  `id: ${seq}\ndata: ${JSON.stringify({ seq, key: `k${seq}`, type: "message.delta", at: new Date().toISOString(), data: {} })}\n\n`,
                ),
              )
            }
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/v1/runs/live/events") {
      // A live stream that never sends an event and never closes.
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    if (url.pathname === "/v1/runs/live") {
      return Response.json({
        runId: "live",
        status: "running",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
      })
    }
    if (url.pathname === "/v1/runs/stale/events") {
      const after = Number(url.searchParams.get("after") ?? 0)
      staleStreams += 1
      const current = staleStreams
      return new Response(
        new ReadableStream({
          start(controller) {
            if (current === 1) {
              // Stale disconnected event: the run is already recovered and live.
              controller.enqueue(
                encoder.encode(
                  `id: 1\ndata: ${JSON.stringify({ seq: 1, key: "k1", type: "run.disconnected", at: new Date().toISOString(), data: {} })}\n\n`,
                ),
              )
            } else {
              controller.enqueue(
                encoder.encode(
                  `id: ${after + 1}\ndata: ${JSON.stringify({ seq: after + 1, key: "k2", type: "run.finished", at: new Date().toISOString(), data: {} })}\n\n`,
                ),
              )
              controller.close()
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/v1/runs/stale") {
      return Response.json({
        runId: "stale",
        status: staleStreams >= 2 ? "cancelled" : "running",
        nodeId: null,
        generation: 2,
        createdAt: new Date().toISOString(),
      })
    }
    if (url.pathname === "/v1/runs/d1/events") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `id: 1\ndata: ${JSON.stringify({ seq: 1, key: "k1", type: "run.disconnected", at: new Date().toISOString(), data: {} })}\n\n`,
              ),
            )
            // The real hub keeps the stream open after run.disconnected.
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/v1/runs/d1") {
      return Response.json({
        runId: "d1",
        status: "disconnected",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
      })
    }
    if (url.pathname === "/v1/nodes") {
      return Response.json({ nodes: [{ nodeId: "n1", name: "box", status: "online" }] })
    }
    if (url.pathname === "/v1/runs/r1") {
      return Response.json({
        runId: "r1",
        status: "running",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
      })
    }
    if (url.pathname === "/v1/runs" && request.method === "POST") {
      return Response.json({
        runId: "r1",
        status: "queued",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
        auth: request.headers.get("authorization"),
      })
    }
    if (url.pathname === "/v1/workflows" && request.method === "POST") {
      return Response.json({
        workflowId: "wf-1",
        status: "running",
        parentRunId: null,
        depth: 0,
        childRunIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      })
    }
    return new Response("not found", { status: 404 })
  },
})

afterAll(() => server.stop(true))

function mcp(overrides: Record<string, string> = {}): {
  call: (name: string, args: unknown) => Promise<any>
  request: (method: string, params?: unknown) => Promise<any>
  send: (method: string, params?: unknown) => { id: number; response: Promise<any> }
  notify: (method: string, params?: unknown) => void
  close: () => void
} {
  const child = spawn(process.execPath, ["run", bin], {
    env: {
      ...process.env,
      AGENTICFORM_HUB_URL: server.url.origin,
      AGENTICFORM_ADMIN_TOKEN: "test-token",
      ...overrides,
    },
    stdio: ["pipe", "pipe", "inherit"],
  })
  const pending = new Map<number, (value: any) => void>()
  let buffer = ""
  let nextId = 1
  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk)
    let end: number
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })
  const send = (method: string, params?: unknown): { id: number; response: Promise<any> } => {
    const id = nextId++
    const response = new Promise<any>((resolve) => {
      pending.set(id, resolve)
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
    return { id, response }
  }
  return {
    call(name, args) {
      return send("tools/call", { name, arguments: args }).response
    },
    request(method, params) {
      return send(method, params).response
    },
    send,
    notify(method, params) {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
    },
    close() {
      child.kill("SIGTERM")
    },
  }
}

const toolError = (response: any): string => {
  expect(response.result.isError).toBe(true)
  return response.result.content[0].text as string
}

describe("MCP boundary validation", () => {
  test("start_run rejects missing and mistyped required fields", async () => {
    const client = mcp()
    try {
      expect(toolError(await client.call("start_run", { harness: "codex", prompt: "p" }))).toContain(
        "idempotencyKey is required",
      )
      expect(
        toolError(await client.call("start_run", { idempotencyKey: "k", harness: 3, prompt: "p" })),
      ).toContain("harness is required and must be a non-empty string")
      expect(
        toolError(await client.call("start_run", { idempotencyKey: "k", harness: "codex", prompt: "p", requires: "x" })),
      ).toContain("requires must be an array of strings")
      expect(
        toolError(await client.call("start_run", { idempotencyKey: "k", harness: "codex", prompt: "p", nope: 1 })),
      ).toContain("unknown start_run argument: nope")
      expect(
        toolError(await client.call("start_run", { idempotencyKey: "k", harness: "codex", prompt: "p", permissionPolicy: "yolo" })),
      ).toContain("permissionPolicy must be allow, ask or deny")
    } finally {
      client.close()
    }
  })

  test("start_run schema advertises mcpServers and gitBacked", async () => {
    const client = mcp()
    try {
      const listed = await client.request("tools/list")
      const tool = listed.result.tools.find((entry: { name: string }) => entry.name === "start_run")
      expect(tool.inputSchema.properties.mcpServers.type).toBe("array")
      expect(tool.inputSchema.properties.gitBacked.type).toBe("boolean")
      expect(tool.inputSchema.properties.permissionPolicy.enum).toEqual(["allow", "ask", "deny"])
    } finally {
      client.close()
    }
  })

  test("get_run rejects a missing runId", async () => {
    const client = mcp()
    try {
      expect(toolError(await client.call("get_run", {}))).toContain("runId is required")
    } finally {
      client.close()
    }
  })

  test("list_events rejects a negative after", async () => {
    const client = mcp()
    try {
      expect(toolError(await client.call("list_events", { runId: "r1", after: -1 }))).toContain(
        "after must be a non-negative integer",
      )
    } finally {
      client.close()
    }
  })

  test("permission tools are advertised and validated", async () => {
    const client = mcp()
    try {
      const listed = await client.request("tools/list")
      const names = listed.result.tools.map((entry: { name: string }) => entry.name)
      expect(names).toContain("list_permissions")
      expect(names).toContain("answer_permission")
      expect(toolError(await client.call("list_permissions", {}))).toContain("runId is required")
      expect(
        toolError(await client.call("answer_permission", { runId: "r1", requestId: "call_7", decision: "maybe" })),
      ).toContain("decision must be allow or deny")
    } finally {
      client.close()
    }
  })

  test("workflow tools are advertised and validated", async () => {
    const client = mcp()
    try {
      const listed = await client.request("tools/list")
      const names = listed.result.tools.map((entry: { name: string }) => entry.name)
      expect(names).toContain("start_workflow")
      expect(names).toContain("get_workflow")
      expect(names).toContain("list_workflows")
      expect(names).toContain("cancel_workflow")

      expect(toolError(await client.call("start_workflow", { code: "return 1" }))).toContain(
        "idempotencyKey is required",
      )
      expect(
        toolError(await client.call("start_workflow", { idempotencyKey: "k", code: "return 1", nope: true })),
      ).toContain("unknown start_workflow argument: nope")
      expect(
        toolError(
          await client.call("start_workflow", {
            idempotencyKey: "k",
            code: "return 1",
            limits: { timeoutMs: 1.5 },
          }),
        ),
      ).toContain("limits.timeoutMs must be an integer")
      expect(toolError(await client.call("get_workflow", {}))).toContain("workflowId is required")
      expect(toolError(await client.call("cancel_workflow", {}))).toContain("workflowId is required")

      const ok = await client.call("start_workflow", { idempotencyKey: "k", code: "return 1" })
      expect(JSON.parse(ok.result.content[0].text).workflowId).toBe("wf-1")
    } finally {
      client.close()
    }
  })
})

describe("MCP list_events follow is bounded", () => {
  test("caps at 1000 events per call and returns nextAfter", async () => {
    const client = mcp()
    try {
      const response = await client.call("list_events", { runId: "r1", follow: true })
      const page = JSON.parse(response.result.content[0].text)
      expect(page.events).toHaveLength(1_000)
      expect(page.nextAfter).toBe(1_000)
    } finally {
      client.close()
    }
  })

  test("stops on a disconnected run and reports status plus nextAfter", async () => {
    const client = mcp()
    try {
      const response = await client.call("list_events", { runId: "d1", follow: true })
      const page = JSON.parse(response.result.content[0].text)
      expect(page.status).toBe("disconnected")
      expect(page.nextAfter).toBe(1)
      expect(page.events).toHaveLength(1)
    } finally {
      client.close()
    }
  })
})

describe("MCP follow concurrency", () => {
  test("answers ping and get_run while a follow is in flight", async () => {
    const client = mcp()
    try {
      const follow = client.send("tools/call", {
        name: "list_events",
        arguments: { runId: "live", follow: true },
      })
      const started = Date.now()
      const ping = await client.request("ping")
      expect(ping.result).toEqual({})
      const get = await client.call("get_run", { runId: "live" })
      expect(JSON.parse(get.result.content[0].text).status).toBe("running")
      expect(Date.now() - started).toBeLessThan(2_000)

      client.notify("notifications/cancelled", { requestId: follow.id })
      const cancelled = await follow.response
      const page = JSON.parse(cancelled.result.content[0].text)
      expect(page.cancelled).toBe(true)
    } finally {
      client.close()
    }
  })

  test("a stale disconnected event on a recovered run keeps following", async () => {
    const client = mcp()
    try {
      const response = await client.call("list_events", { runId: "stale", follow: true })
      const page = JSON.parse(response.result.content[0].text)
      expect(page.events.map((event: { type: string }) => event.type)).toEqual([
        "run.disconnected",
        "run.finished",
      ])
      expect(page.nextAfter).toBe(2)
      expect(page.status).toBeUndefined()
      expect(staleStreams).toBe(2)
    } finally {
      client.close()
    }
  })
})

describe("MCP caller token", () => {
  test("uses AGENTICFORM_TOKEN when the admin token is unset", async () => {
    const client = mcp({ AGENTICFORM_ADMIN_TOKEN: "", AGENTICFORM_TOKEN: "afc_abcdefghijkl_secret" })
    try {
      const response = await client.call("start_run", {
        idempotencyKey: "k",
        harness: "codex",
        prompt: "p",
      })
      const run = JSON.parse(response.result.content[0].text)
      expect(run.auth).toBe("Bearer afc_abcdefghijkl_secret")
    } finally {
      client.close()
    }
  })
})

describe("MCP initialize negotiation", () => {  test("echoes a supported version and falls back to the latest otherwise", async () => {
    const client = mcp()
    try {
      const supported = await client.request("initialize", { protocolVersion: "2024-11-05" })
      expect(supported.result.protocolVersion).toBe("2024-11-05")
      const unknown = await client.request("initialize", { protocolVersion: "1999-01-01" })
      expect(unknown.result.protocolVersion).toBe("2024-11-05")
    } finally {
      client.close()
    }
  })
})

const MODERN = "2026-07-28"

const meta = (version: string = MODERN) => ({
  _meta: {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": {},
  },
})

describe("MCP 2026-07-28 per-request metadata", () => {
  test("server/discover advertises the modern version without a handshake", async () => {
    const client = mcp()
    try {
      const { result } = await client.request("server/discover", meta())
      expect(result).toEqual({
        resultType: "complete",
        supportedVersions: [MODERN],
        capabilities: { tools: {} },
        ttlMs: 3_600_000,
        cacheScope: "public",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "agenticform", version: "0.1.0" } },
      })
    } finally {
      client.close()
    }
  })

  test("an unsupported version is refused with the supported list, and nothing runs", async () => {
    const client = mcp()
    try {
      const response = await client.request("tools/call", { name: "list_nodes", ...meta("1900-01-01") })
      expect(response.result).toBeUndefined()
      expect(response.error.code).toBe(-32022)
      expect(response.error.data).toEqual({ supported: [MODERN], requested: "1900-01-01" })
    } finally {
      client.close()
    }
  })

  test("a request missing required metadata is invalid", async () => {
    const client = mcp()
    try {
      expect((await client.request("server/discover")).error.code).toBe(-32602)
      const partial = { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } }
      expect((await client.request("tools/list", partial)).error.code).toBe(-32602)
    } finally {
      client.close()
    }
  })

  test("removed and unknown names are protocol errors", async () => {
    const client = mcp()
    try {
      expect((await client.request("ping", meta())).error.code).toBe(-32601)
      expect((await client.request("tools/call", { name: "nope", ...meta() })).error.code).toBe(-32602)
    } finally {
      client.close()
    }
  })

  test("tools/list is cacheable and every tool declares its output", async () => {
    const client = mcp()
    try {
      const { result } = await client.request("tools/list", meta())
      expect(result.resultType).toBe("complete")
      expect(result.ttlMs).toBe(3_600_000)
      expect(result.cacheScope).toBe("public")
      for (const tool of result.tools) expect(["object", "array"]).toContain(tool.outputSchema?.type)
    } finally {
      client.close()
    }
  })

  test("tool results carry structuredContent matching the text block", async () => {
    const client = mcp()
    try {
      const nodes = (await client.request("tools/call", { name: "list_nodes", ...meta() })).result
      expect(nodes.resultType).toBe("complete")
      expect(nodes.structuredContent).toEqual([{ nodeId: "n1", name: "box", status: "online" }])
      expect(JSON.parse(nodes.content[0].text)).toEqual(nodes.structuredContent)

      const failed = (await client.request("tools/call", { name: "get_run", arguments: {}, ...meta() })).result
      expect(failed.resultType).toBe("complete")
      expect(failed.isError).toBe(true)
      expect(failed.structuredContent).toBeUndefined()
    } finally {
      client.close()
    }
  })

  test("a cancelled request gets no response", async () => {
    const client = mcp()
    try {
      const follow = client.send("tools/call", {
        name: "list_events",
        arguments: { runId: "live", follow: true },
        ...meta(),
      })
      client.notify("notifications/cancelled", { requestId: follow.id })
      const outcome = await Promise.race([follow.response, Bun.sleep(1_000).then(() => "silent")])
      expect(outcome).toBe("silent")
      expect((await client.request("server/discover", meta())).result.resultType).toBe("complete")
    } finally {
      client.close()
    }
  })
})

describe("MCP legacy results are unchanged", () => {
  test("no modern fields reach a client that did not send modern metadata", async () => {
    const client = mcp()
    try {
      const listed = (await client.request("tools/list")).result
      expect(Object.keys(listed)).toEqual(["tools"])
      for (const tool of listed.tools) expect(tool.outputSchema).toBeUndefined()
      const nodes = (await client.call("list_nodes", {})).result
      expect(Object.keys(nodes)).toEqual(["content"])
    } finally {
      client.close()
    }
  })
})

describe("MCP tool annotations", () => {
  test("only reads are marked read-only; every write is marked destructive", async () => {
    const client = mcp()
    try {
      const { tools } = (await client.request("tools/list")).result
      const readOnly = tools.filter((tool: any) => tool.annotations?.readOnlyHint === true).map((tool: any) => tool.name)
      expect(readOnly).toEqual([
        "list_nodes",
        "get_run",
        "list_events",
        "list_permissions",
        "get_workflow",
        "list_workflows",
      ])
      for (const tool of tools) {
        if (readOnly.includes(tool.name)) continue
        expect(tool.annotations?.destructiveHint).toBe(true)
      }
    } finally {
      client.close()
    }
  })
})
