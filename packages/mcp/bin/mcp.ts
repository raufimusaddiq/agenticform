#!/usr/bin/env bun
import { createInterface } from "node:readline"
import type { RunEventWire, RunRequest } from "@agenticform/client"
import {
  HubApiError,
  HubClient,
  TERMINAL_RUN_STATUSES,
  normalizeAfter,
  reconnectDelay,
} from "@agenticform/client"

/** Cap buffered follow events per call; the caller pages with `nextAfter`. */
const MAX_EVENTS = 1_000

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
        mcpServers: { type: "array", items: {} },
        nodeId: { type: "string" },
        labels: { type: "object", additionalProperties: { type: "string" } },
        gitBacked: { type: "boolean" },
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

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || !value) throw new Error(`${key} is required and must be a non-empty string`)
  return value
}

/** Validate start_run arguments at the MCP boundary against the tool schema. */
function startRunRequest(args: Record<string, unknown>): RunRequest {
  const allowed = new Set([
    "idempotencyKey", "harness", "prompt", "cwd", "requires", "mcpServers", "nodeId", "labels", "gitBacked",
  ])
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`unknown start_run argument: ${key}`)
  }
  const request: RunRequest = {
    idempotencyKey: requireString(args, "idempotencyKey"),
    harness: requireString(args, "harness"),
    prompt: requireString(args, "prompt"),
  }
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== "string") throw new Error("cwd must be a string")
    request.cwd = args.cwd
  }
  if (args.nodeId !== undefined) {
    if (typeof args.nodeId !== "string") throw new Error("nodeId must be a string")
    request.nodeId = args.nodeId
  }
  if (args.requires !== undefined) {
    if (!Array.isArray(args.requires) || args.requires.some((item) => typeof item !== "string")) {
      throw new Error("requires must be an array of strings")
    }
    request.requires = args.requires as string[]
  }
  if (args.mcpServers !== undefined) {
    if (!Array.isArray(args.mcpServers)) throw new Error("mcpServers must be an array")
    request.mcpServers = args.mcpServers
  }
  if (args.labels !== undefined) {
    if (
      args.labels === null ||
      typeof args.labels !== "object" ||
      Array.isArray(args.labels) ||
      Object.values(args.labels).some((value) => typeof value !== "string")
    ) {
      throw new Error("labels must be a flat string map")
    }
    request.labels = args.labels as Record<string, string>
  }
  if (args.gitBacked !== undefined) {
    if (typeof args.gitBacked !== "boolean") throw new Error("gitBacked must be a boolean")
    request.gitBacked = args.gitBacked
  }
  return request
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const hub = client()
  switch (name) {
    case "list_nodes":
      return hub.listNodes()
    case "start_run":
      return hub.createRun(startRunRequest(args))
    case "get_run":
      return hub.getRun(requireString(args, "runId"))
    case "cancel_run":
      return hub.cancelRun(requireString(args, "runId"))
    case "list_events": {
      const runId = requireString(args, "runId")
      const after = normalizeAfter(args.after ?? 0)
      if (!args.follow) {
        const page = await hub.getEvents(runId, after)
        return { events: page.events, nextAfter: page.events.at(-1)?.seq ?? after }
      }
      const events: RunEventWire[] = []
      const controller = new AbortController()
      let cursor = after
      let attempt = 0
      while (true) {
        const before = cursor
        try {
          cursor = await hub.followEvents(
            runId,
            cursor,
            (event) => {
              events.push(event)
              if (events.length >= MAX_EVENTS) controller.abort()
            },
            controller.signal,
          )
        } catch (error) {
          // A dropped connection is no progress; resume from the last event seen.
          if (error instanceof HubApiError) throw error
          cursor = events.at(-1)?.seq ?? cursor
        }
        const nextAfter = events.at(-1)?.seq ?? after
        if (events.length >= MAX_EVENTS) return { events, nextAfter }
        const run = await hub.getRun(runId)
        if (TERMINAL_RUN_STATUSES.has(run.status)) return { events, nextAfter }
        attempt = cursor > before ? 0 : attempt + 1
        await reconnectDelay(attempt)
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
