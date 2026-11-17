#!/usr/bin/env bun
import { createInterface } from "node:readline"
import { HubApiError, HubClient } from "@agenticform/client"

const TOOLS = [
  {
    name: "list_nodes",
    description: "List hub machines (nodes), their status, harnesses and capacity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_run",
    description: "Start a run. Repeating the same idempotency key returns the same run.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
        harness: { type: "string" },
        prompt: { type: "string" },
        cwd: { type: "string" },
        requires: { type: "array", items: { type: "string" } },
        nodeId: { type: "string" },
        labels: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["idempotencyKey", "harness", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "get_run",
    description: "Get a run's status, result or error.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_events",
    description: "Page a run's events from a sequence number, or follow them to the terminal event.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        after: { type: "number" },
        follow: { type: "boolean" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_run",
    description: "Cancel a run.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
] as const

function client(): HubClient {
  const url = process.env.AGENTICFORM_HUB_URL
  const token = process.env.AGENTICFORM_ADMIN_TOKEN
  if (!url) throw new Error("AGENTICFORM_HUB_URL is required")
  if (!token) throw new Error("AGENTICFORM_ADMIN_TOKEN is required")
  return new HubClient({ url, token })
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const hub = client()
  const runId = String(args.runId ?? "")
  switch (name) {
    case "list_nodes":
      return hub.listNodes()
    case "start_run":
      return hub.createRun(args as never)
    case "get_run":
      return hub.getRun(runId)
    case "cancel_run":
      return hub.cancelRun(runId)
    case "list_events": {
      const after = Number(args.after ?? 0)
      if (!args.follow) return hub.getEvents(runId, after)
      const events: unknown[] = []
      let cursor = after
      let attempt = 0
      while (true) {
        const before = cursor
        cursor = await hub.followEvents(runId, cursor, (event) => events.push(event))
        const run = await hub.getRun(runId)
        if (["completed", "failed", "cancelled"].includes(run.status)) return events
        attempt = cursor > before ? 0 : attempt + 1
        if (attempt > 5) throw new Error("event stream did not advance after 5 retries")
        await Bun.sleep(Math.min(100 * 2 ** attempt, 5_000))
      }
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

const send = (body: unknown): void => {
  process.stdout.write(`${JSON.stringify(body)}\n`)
}

async function handle(message: any): Promise<void> {
  const id = message?.id
  if (typeof message?.method !== "string") return
  if (message.id === undefined) return // notification

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agenticform", version: "0.1.0" },
      },
    })
    return
  }
  if (message.method === "ping") return send({ jsonrpc: "2.0", id, result: {} })
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
  if (message.method === "tools/call") {
    const name = message.params?.name as string
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>
    try {
      const value = await call(name, args)
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      })
    } catch (error) {
      const text =
        error instanceof HubApiError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error)
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } })
    }
    return
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${message.method}` } })
}

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (!line.trim()) continue
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
    continue
  }
  await handle(message)
}
