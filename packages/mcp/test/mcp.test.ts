import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"

const bin = join(import.meta.dir, "..", "bin", "mcp.ts")
const encoder = new TextEncoder()

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
    if (url.pathname === "/v1/runs/r1") {
      return Response.json({
        runId: "r1",
        status: "running",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
      })
    }
    return new Response("not found", { status: 404 })
  },
})

afterAll(() => server.stop(true))

function mcp(): { call: (name: string, args: unknown) => Promise<any>; close: () => void } {
  const child = spawn(process.execPath, ["run", bin], {
    env: {
      ...process.env,
      AGENTICFORM_HUB_URL: server.url.origin,
      AGENTICFORM_ADMIN_TOKEN: "test-token",
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
  return {
    call(name, args) {
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`,
        )
      })
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
})
