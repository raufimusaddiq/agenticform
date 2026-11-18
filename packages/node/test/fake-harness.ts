import { spawn, spawnSync } from "node:child_process"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"

/**
 * A real ACP child that runs inside the sandbox. It speaks NDJSON JSON-RPC
 * directly so it needs no node_modules, attempts writes and reports the errno,
 * answers `auth_required` on request, and can hold a turn open with a grandchild
 * so cancellation can be observed. The spec arrives as argv because the sandbox
 * clears the environment.
 */
const spec = JSON.parse(process.argv[2] ?? "{}") as {
  scenario?: string
  writes?: string[]
  reads?: string[]
  lists?: string[]
  marker?: string
  exec?: string
}

let cancelled: (() => void) | null = null
const untilCancelled = () => new Promise<void>((resolve) => (cancelled = resolve))

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params })
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result })
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } })

const say = (sessionId: string, text: string) =>
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  })

const attempt = (path: string): string => {
  try {
    writeFileSync(path, "x")
    return `${path}=ok`
  } catch (error) {
    return `${path}=${(error as NodeJS.ErrnoException).code ?? "error"}`
  }
}

const read = (path: string): string => {
  try {
    readFileSync(path)
    return `read:${path}=ok`
  } catch (error) {
    return `read:${path}=${(error as NodeJS.ErrnoException).code ?? "error"}`
  }
}

const list = (path: string): string => {
  try {
    return `list:${path}=${readdirSync(path).sort().join(",")}`
  } catch (error) {
    return `list:${path}=${(error as NodeJS.ErrnoException).code ?? "error"}`
  }
}

async function handle(message: { id?: unknown; method?: string; params?: any }): Promise<void> {
  const { id, method, params } = message
  if (method === "initialize") {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "fake-harness", version: "1.0.0" },
    })
    return
  }
  if (method === "session/new") {
    if (spec.scenario === "auth") {
      fail(id, -32000, "Authentication required")
      return
    }
    reply(id, { sessionId: "session-1" })
    return
  }
  if (method === "session/prompt") {
    const sessionId = params.sessionId as string
    if (spec.scenario === "writes") {
      const lines = [...(spec.writes ?? []).map(attempt), ...(spec.reads ?? []).map(read)]
      say(sessionId, lines.join("\n"))
      reply(id, { stopReason: "end_turn" })
      return
    }
    if (spec.scenario === "exec") {
      const result = spawnSync(spec.exec as string, [], { encoding: "utf8" })
      say(sessionId, `${spec.exec}=${result.status}:${(result.stdout ?? "").trim()}`)
      reply(id, { stopReason: "end_turn" })
      return
    }
    if (spec.scenario === "env") {
      const lines = Object.entries(process.env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${value}`)
      say(sessionId, lines.join("\n"))
      reply(id, { stopReason: "end_turn" })
      return
    }
    if (spec.scenario === "list") {
      say(sessionId, (spec.lists ?? []).map(list).join("\n"))
      reply(id, { stopReason: "end_turn" })
      return
    }
    if (spec.scenario === "child") {
      const marker = spec.marker ?? "af-fake-child"
      spawn("sh", ["-c", `sleep 300; : ${marker}`], { stdio: "ignore" })
      say(sessionId, marker)
      await untilCancelled()
      reply(id, { stopReason: "cancelled" })
      return
    }
    if (spec.scenario === "hang") return
    say(sessionId, "ok")
    reply(id, { stopReason: "end_turn" })
    return
  }
  if (method === "session/cancel") {
    cancelled?.()
    return
  }
  if (id !== undefined) fail(id, -32601, "Method not found")
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
