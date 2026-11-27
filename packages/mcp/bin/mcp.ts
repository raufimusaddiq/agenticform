#!/usr/bin/env bun
import { createInterface } from "node:readline"
import type { RunEventWire, RunRequest, WorkflowLimits, WorkflowRequest } from "@agenticform/client"
import {
  FOLLOW_STOP_STATUSES,
  HubApiError,
  HubClient,
  normalizeAfter,
  reconnectDelay,
  resolveClientConfig,
} from "@agenticform/client"

/** Cap buffered follow events per call; the caller pages with `nextAfter`. */
const MAX_EVENTS = 1_000
/** Follow time budget; a long follow returns `nextAfter` for the caller to page. */
const FOLLOW_BUDGET_MS = 30_000

/** In-flight cancellable requests, keyed by JSON-RPC id. */
const inFlight = new Map<unknown, () => void>()
/** Modern tool calls still owed a response; a cancelled one must get none. */
const owed = new Set<unknown>()

/** Annotations are hints for the client. Reads touch only the hub; writes can reach anything a run can. */
const READS = { readOnlyHint: true, openWorldHint: false }
const WRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }

/** Output schemas name only what callers can rely on; the hub may add fields. */
const view = (...required: string[]) => ({
  type: "object",
  properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])),
  required,
})
const listOf = (...required: string[]) => ({ type: "array", items: view(...required) })
const RUN = view("runId", "status")
const WORKFLOW = view("workflowId", "status")
const PERMISSION = ["requestId", "status"]

const TOOLS = [
  {
    name: "list_nodes",
    annotations: READS,
    outputSchema: listOf("nodeId"),
    description: "List hub machines (nodes), their status, harnesses and capacity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_run",
    annotations: WRITES,
    outputSchema: RUN,
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
        parentRunId: { type: "string" },
        permissionPolicy: {
          type: "string",
          enum: ["allow", "ask", "deny"],
          description: "Default allow: the sandbox is the boundary. ask waits for an owner answer; deny refuses all.",
        },
      },
      required: ["idempotencyKey", "harness", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "get_run",
    annotations: READS,
    outputSchema: RUN,
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
    annotations: READS,
    outputSchema: {
      type: "object",
      properties: { events: { type: "array" }, nextAfter: { type: "integer" } },
      required: ["events", "nextAfter"],
    },
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
    annotations: WRITES,
    outputSchema: RUN,
    description: "Cancel a run.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_permissions",
    annotations: READS,
    outputSchema: listOf(...PERMISSION),
    description: "List a run's permission requests and their status.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "answer_permission",
    annotations: WRITES,
    outputSchema: view(...PERMISSION),
    description: "Allow or deny a pending permission request. Owner only.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        requestId: { type: "string" },
        decision: { type: "string", enum: ["allow", "deny"] },
      },
      required: ["runId", "requestId", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "start_workflow",
    annotations: WRITES,
    outputSchema: WORKFLOW,
    description:
      "Start a durable Psychoscript workflow on the hub. Code runs in a confined JS VM with no ambient I/O and only af.run(req), af.startRun(req), af.getRun(id), af.cancelRun(id), af.listNodes(), af.listEvents(id, after?), and af.listPermissions(id).",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
        code: { type: "string" },
        bindings: { type: "object" },
        parentRunId: { type: "string" },
        limits: {
          type: "object",
          properties: {
            timeoutMs: { type: "number" },
            maxOutputBytes: { type: "number" },
            maxSnapshotBytes: { type: "number" },
            maxChildRuns: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      required: ["idempotencyKey", "code"],
      additionalProperties: false,
    },
  },
  {
    name: "get_workflow",
    annotations: READS,
    outputSchema: WORKFLOW,
    description: "Get a workflow's status, child runs, logs, result, or error.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" } },
      required: ["workflowId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_workflows",
    annotations: READS,
    outputSchema: listOf("workflowId", "status"),
    description: "List workflows stored on the hub.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_workflow",
    annotations: WRITES,
    outputSchema: WORKFLOW,
    description: "Cancel a running or suspended workflow and its active child runs.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" } },
      required: ["workflowId"],
      additionalProperties: false,
    },
  },
] as const

function client(): HubClient {
  const { url, token } = resolveClientConfig()
  if (!url) throw new Error("hub URL is not configured (run `af init client` or set AGENTICFORM_HUB_URL)")
  if (!token) {
    throw new Error(
      "token is not configured (run `af init client` or set AGENTICFORM_ADMIN_TOKEN / AGENTICFORM_TOKEN)",
    )
  }
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
    "parentRunId", "permissionPolicy",
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
  if (args.parentRunId !== undefined) {
    if (typeof args.parentRunId !== "string") throw new Error("parentRunId must be a string")
    request.parentRunId = args.parentRunId
  }
  if (args.permissionPolicy !== undefined) {
    if (args.permissionPolicy !== "allow" && args.permissionPolicy !== "ask" && args.permissionPolicy !== "deny") {
      throw new Error("permissionPolicy must be allow, ask or deny")
    }
    request.permissionPolicy = args.permissionPolicy
  }
  return request
}

/** Validate start_workflow arguments at the MCP boundary against the tool schema. */
function startWorkflowRequest(args: Record<string, unknown>): WorkflowRequest {
  const allowed = new Set(["idempotencyKey", "code", "bindings", "parentRunId", "limits"])
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`unknown start_workflow argument: ${key}`)
  }
  const request: WorkflowRequest = {
    idempotencyKey: requireString(args, "idempotencyKey"),
    code: requireString(args, "code"),
  }
  if (args.bindings !== undefined) {
    if (args.bindings === null || typeof args.bindings !== "object" || Array.isArray(args.bindings)) {
      throw new Error("bindings must be a plain object")
    }
    request.bindings = args.bindings as Record<string, unknown>
  }
  if (args.parentRunId !== undefined) {
    if (typeof args.parentRunId !== "string" || !args.parentRunId) {
      throw new Error("parentRunId must be a non-empty string")
    }
    request.parentRunId = args.parentRunId
  }
  if (args.limits !== undefined) {
    if (args.limits === null || typeof args.limits !== "object" || Array.isArray(args.limits)) {
      throw new Error("limits must be an object")
    }
    const raw = args.limits as Record<string, unknown>
    const allowedLimits = new Set(["timeoutMs", "maxOutputBytes", "maxSnapshotBytes", "maxChildRuns"])
    for (const key of Object.keys(raw)) {
      if (!allowedLimits.has(key)) throw new Error(`unknown limit: ${key}`)
      if (typeof raw[key] !== "number" || !Number.isInteger(raw[key])) {
        throw new Error(`limits.${key} must be an integer`)
      }
    }
    request.limits = raw as WorkflowLimits
  }
  return request
}

async function followRun(
  hub: HubClient,
  runId: string,
  after: number,
  requestId: unknown,
): Promise<unknown> {
  const events: RunEventWire[] = []
  let cursor = after
  let attempt = 0
  const deadline = Date.now() + FOLLOW_BUDGET_MS
  let cancelled = false
  let current: AbortController | undefined
  const cancel = (): void => {
    cancelled = true
    current?.abort()
  }
  inFlight.set(requestId, cancel)
  try {
    while (true) {
      if (Date.now() >= deadline) {
        return { events, nextAfter: events.at(-1)?.seq ?? after, timedOut: true }
      }
      const before = cursor
      // A fresh controller per iteration: a stale run.disconnected must not
      // poison the next stream after the run is recovered.
      current = new AbortController()
      let abortedByEvent = false
      const timer = setTimeout(() => current?.abort(), Math.max(0, deadline - Date.now()))
      try {
        cursor = await hub.followEvents(
          runId,
          cursor,
          (event) => {
            events.push(event)
            // The hub keeps the stream open after run.disconnected; stop here.
            if (event.type === "run.disconnected") {
              abortedByEvent = true
              current?.abort()
            } else if (events.length >= MAX_EVENTS) {
              current?.abort()
            }
          },
          current.signal,
        )
      } catch (error) {
        // A dropped connection is no progress; resume from the last event seen.
        if (error instanceof HubApiError) throw error
        cursor = events.at(-1)?.seq ?? cursor
      } finally {
        clearTimeout(timer)
      }
      const nextAfter = events.at(-1)?.seq ?? after
      if (cancelled) return { events, nextAfter, cancelled: true }
      if (Date.now() >= deadline) return { events, nextAfter, timedOut: true }
      if (events.length >= MAX_EVENTS) return { events, nextAfter }
      const run = await hub.getRun(runId)
      if (run.status === "disconnected") return { status: "disconnected", events, nextAfter }
      if (FOLLOW_STOP_STATUSES.has(run.status)) return { events, nextAfter }
      if (abortedByEvent) {
        // Stale disconnected event on a recovered run: keep following, no retry.
        attempt = 0
        continue
      }
      if (cursor > before) attempt = 0
      await reconnectDelay(attempt)
      attempt += 1
    }
  } finally {
    inFlight.delete(requestId)
  }
}

async function call(name: string, args: Record<string, unknown>, requestId: unknown): Promise<unknown> {
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
    case "list_permissions":
      return hub.listPermissions(requireString(args, "runId"))
    case "answer_permission": {
      const decision = args.decision
      if (decision !== "allow" && decision !== "deny") throw new Error("decision must be allow or deny")
      return hub.answerPermission(
        requireString(args, "runId"),
        requireString(args, "requestId"),
        decision,
      )
    }
    case "list_events": {
      const runId = requireString(args, "runId")
      const after = normalizeAfter(args.after ?? 0)
      if (!args.follow) {
        const page = await hub.getEvents(runId, after)
        return { events: page.events, nextAfter: page.events.at(-1)?.seq ?? after }
      }
      return followRun(hub, runId, after, requestId)
    }
    case "start_workflow":
      return hub.createWorkflow(startWorkflowRequest(args))
    case "get_workflow":
      return hub.getWorkflow(requireString(args, "workflowId"))
    case "list_workflows":
      return hub.listWorkflows()
    case "cancel_workflow":
      return hub.cancelWorkflow(requireString(args, "workflowId"))
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

/** Revisions that carry version and capabilities on every request, with no handshake. */
const MODERN_MCP_VERSIONS = ["2026-07-28"]
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion"
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities"
const SERVER_INFO = { name: "agenticform", version: "0.1.0" }
const CAPABILITIES = { tools: {} }
/** The tool list changes only when this process is replaced, and holds no user data. */
const CACHE = { ttlMs: 3_600_000, cacheScope: "public" }

/** `initialize` revisions this server implements; the last is the latest. */
const SUPPORTED_MCP_VERSIONS = ["2024-11-05"] as const
const LATEST_MCP_VERSION = SUPPORTED_MCP_VERSIONS[SUPPORTED_MCP_VERSIONS.length - 1] as string

const send = (body: unknown): void => {
  process.stdout.write(`${JSON.stringify(body)}\n`)
}

async function handle(message: any): Promise<void> {
  const id = message?.id
  if (typeof message?.method !== "string") return
  if (message.method === "notifications/cancelled") {
    owed.delete(message.params?.requestId)
    inFlight.get(message.params?.requestId)?.()
    return
  }
  if (message.id === undefined) return // other notifications

  // A client picks its era per request: modern metadata, or the legacy handshake.
  const meta = message.params?._meta
  const version = meta?.[VERSION_KEY]
  const modern = version !== undefined || message.method === "server/discover"
  const fail = (code: number, text: string, data?: unknown): void =>
    send({ jsonrpc: "2.0", id, error: { code, message: text, data } })
  const reply = (result: object): void =>
    send({
      jsonrpc: "2.0",
      id,
      result: modern
        ? { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } }
        : result,
    })
  if (modern) {
    if (typeof version !== "string" || typeof meta[CAPABILITIES_KEY] !== "object" || meta[CAPABILITIES_KEY] === null) {
      return fail(-32602, `_meta must include ${VERSION_KEY} and ${CAPABILITIES_KEY}`)
    }
    if (!MODERN_MCP_VERSIONS.includes(version)) {
      return fail(-32022, "Unsupported protocol version", { supported: MODERN_MCP_VERSIONS, requested: version })
    }
    if (message.method === "server/discover") {
      return reply({ supportedVersions: MODERN_MCP_VERSIONS, capabilities: CAPABILITIES, ...CACHE })
    }
    // The handshake and ping do not exist in this era.
    if (message.method === "initialize" || message.method === "ping") {
      return fail(-32601, `method not found: ${message.method}`)
    }
  }

  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion
    const protocolVersion = SUPPORTED_MCP_VERSIONS.includes(requested)
      ? requested
      : LATEST_MCP_VERSION
    return reply({ protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO })
  }
  if (message.method === "ping") return reply({})
  if (message.method === "tools/list") {
    // Legacy clients may validate outputSchema as object-only, so only modern ones get it.
    return reply(modern ? { tools: TOOLS, ...CACHE } : { tools: TOOLS.map(({ outputSchema, ...tool }) => tool) })
  }
  if (message.method === "tools/call") {
    const name = message.params?.name as string
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>
    if (modern) {
      if (!TOOLS.some((tool) => tool.name === name)) return fail(-32602, `Unknown tool: ${name}`)
      owed.add(id)
    }
    let result: object
    try {
      const value = await call(name, args, id)
      result = {
        content: [{ type: "text", text: JSON.stringify(value) }],
        ...(modern ? { structuredContent: value } : {}),
      }
    } catch (error) {
      const text =
        error instanceof HubApiError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error)
      result = { content: [{ type: "text", text }], isError: true }
    }
    if (modern && !owed.delete(id)) return
    return reply(result)
  }
  fail(-32601, `method not found: ${message.method}`)
}

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (!line.trim()) continue
  let message: any
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
    continue
  }
  // Dispatch concurrently so a long follow never blocks other requests.
  void handle(message).catch((error) => {
    if (message?.id === undefined) return
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    })
  })
}
