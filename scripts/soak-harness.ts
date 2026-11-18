#!/usr/bin/env bun
/**
 * The soak's fake ACP agent (FR-018). It speaks NDJSON JSON-RPC directly, so it
 * needs no node_modules and runs inside the sandbox like a real harness.
 *
 * The first argv word is the run's marker: the runner sets it per run and scans
 * the host `/proc` for it while this process is held alive below. That records
 * the host process group at spawn, before ACP init, so the orphan check can be
 * per run instead of a poll that can miss a fast cancel.
 *
 * The prompt text picks the behaviour:
 *   - `complete`   one message, then `end_turn`
 *   - `hang`       hold the turn open until `session/cancel`
 *   - `permission` ask the client, report the decision, then `end_turn`
 *
 * The permission request is the real ACP shape, so the runtime's own handler,
 * timeout and `permission.resolved` event are exercised, not simulated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const marker = process.argv[2] ?? `anon-${process.pid}`
const harnessDir = join(process.cwd(), "harness")
try {
  mkdirSync(harnessDir, { recursive: true })
  const pgid = (() => {
    try {
      // Inside the sandbox PID namespace, so this is only reported, never trusted.
      const stat = readFileSync("/proc/self/stat", "utf8")
      const close = stat.lastIndexOf(")")
      return Number(stat.slice(close + 2).split(" ")[2])
    } catch {
      return process.pid
    }
  })()
  writeFileSync(
    join(harnessDir, `spawn-${marker}.json`),
    JSON.stringify({ marker, pid: process.pid, pgid, at: new Date().toISOString() }),
  )
} catch {
  // No writable workspace: the runner then sees no spawn record and fails it.
}
// Hold still until the runner has recorded the host group, so a fast run cannot
// start and exit between two scans.
const release = join(harnessDir, `spawn-${marker}.ready`)
const releaseBy = Date.now() + 10_000
while (!existsSync(release) && Date.now() < releaseBy) Bun.sleepSync(5)

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const reply = (id: unknown, result: unknown): void => send({ jsonrpc: "2.0", id, result })
const notify = (method: string, params: unknown): void => send({ jsonrpc: "2.0", method, params })

let cancelled: (() => void) | null = null
const untilCancelled = (): Promise<void> => new Promise((resolve) => (cancelled = resolve))

let nextId = 1
const pending = new Map<number, (result: unknown) => void>()
const request = (method: string, params: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    send({ jsonrpc: "2.0", id, method, params })
  })

const say = (sessionId: string, text: string): void =>
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  })

const promptText = (params: { prompt?: unknown }): string => {
  const blocks = Array.isArray(params.prompt) ? params.prompt : []
  return blocks
    .map((block) => {
      const item = block as { type?: unknown; text?: unknown }
      return item.type === "text" && typeof item.text === "string" ? item.text : ""
    })
    .join("")
}

async function handle(message: {
  id?: unknown
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}): Promise<void> {
  const { id, method, params } = message
  if (method === undefined && typeof id === "number") {
    pending.get(id)?.(message.result)
    pending.delete(id)
    return
  }
  if (method === "initialize") {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "soak-harness", version: "1.0.0" },
    })
    return
  }
  if (method === "session/new") {
    reply(id, { sessionId: "soak-session" })
    return
  }
  if (method === "session/prompt") {
    const sessionId = String(params?.sessionId ?? "")
    const text = promptText(params ?? {})
    if (text.startsWith("hang")) {
      await untilCancelled()
      reply(id, { stopReason: "cancelled" })
      return
    }
    if (text.startsWith("permission")) {
      const toolCallId = `call-${nextId}`
      const answer = (await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId, title: "Run the soak command", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      })) as { outcome?: { outcome?: string; optionId?: string } } | undefined
      const decision =
        answer?.outcome?.outcome === "selected" ? (answer.outcome.optionId ?? "cancelled") : "cancelled"
      say(sessionId, `permission:${decision}`)
      reply(id, { stopReason: "end_turn" })
      return
    }
    say(sessionId, "ok")
    reply(id, { stopReason: "end_turn" })
    return
  }
  if (method === "session/cancel") {
    cancelled?.()
    return
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let index: number
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) void handle(JSON.parse(line))
  }
})
