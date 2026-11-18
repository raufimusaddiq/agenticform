#!/usr/bin/env bun
import type { RunRequest } from "@agenticform/protocol"
import {
  FOLLOW_STOP_STATUSES,
  HubApiError,
  HubClient,
  normalizeAfter,
  reconnectDelay,
} from "@agenticform/client"

const USAGE = `usage: af <command>
  af nodes
  af run start --harness <h> --prompt <text> --key <idempotency-key>
               [--cwd <dir>] [--node <id>] [--requires a,b] [--label k=v]...
  af run get <runId>
  af run events <runId> [--after <seq>] [--follow]
  af run cancel <runId>

Flags also accept --flag=value. Use that form when a value starts with "--".

Environment: AGENTICFORM_HUB_URL, AGENTICFORM_ADMIN_TOKEN`

function client(): HubClient {
  const url = process.env.AGENTICFORM_HUB_URL
  const token = process.env.AGENTICFORM_ADMIN_TOKEN
  if (!url) throw new Error("AGENTICFORM_HUB_URL is required")
  if (!token) throw new Error("AGENTICFORM_ADMIN_TOKEN is required")
  return new HubClient({ url, token })
}

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline !== undefined) return inline.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`)
  return value
}

function flags(args: string[], name: string): string[] {
  const prefix = `--${name}=`
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length))
      continue
    }
    if (arg !== `--${name}`) continue
    const value = args[i + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`)
    values.push(value)
  }
  return values
}

export function parseLabels(values: string[]): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const raw of values) {
    const equals = raw.indexOf("=")
    if (equals <= 0) throw new Error(`invalid --label "${raw}": expected key=value`)
    labels[raw.slice(0, equals)] = raw.slice(equals + 1)
  }
  return labels
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function main(argv: string[]): Promise<void> {
  const [group, action, id] = argv
  const rest = argv.slice(action === "start" ? 2 : 3)
  const hub = client()

  if (group === "nodes") return print(await hub.listNodes())

  if (group === "run" && action === "start") {
    const harness = flag(rest, "harness")
    const prompt = flag(rest, "prompt")
    const idempotencyKey = flag(rest, "key")
    if (!harness || !prompt || !idempotencyKey) throw new Error("--harness, --prompt and --key are required")
    const requires = flag(rest, "requires")
    const cwd = flag(rest, "cwd")
    const node = flag(rest, "node")
    const labels = parseLabels(flags(rest, "label"))
    const request: RunRequest = {
      idempotencyKey,
      harness,
      prompt,
      ...(cwd === undefined ? {} : { cwd }),
      ...(node === undefined ? {} : { nodeId: node }),
      ...(requires === undefined ? {} : { requires: requires.split(",").filter(Boolean) }),
      ...(Object.keys(labels).length ? { labels } : {}),
    }
    return print(await hub.createRun(request))
  }

  if (group === "run" && action === "get" && id) return print(await hub.getRun(id))
  if (group === "run" && action === "cancel" && id) return print(await hub.cancelRun(id))

  if (group === "run" && action === "events" && id) {
    let after = normalizeAfter(flag(rest, "after") ?? 0)
    if (!rest.includes("--follow")) {
      const page = await hub.getEvents(id, after)
      return print(page)
    }
    let lastSeen = after
    let attempt = 0
    while (true) {
      const before = after
      try {
        lastSeen = await hub.followEvents(id, after, (event) => {
          lastSeen = event.seq
          print(event)
        })
        after = lastSeen
      } catch (error) {
        // A dropped connection is no progress: back off, then resume from the last seq seen.
        if (error instanceof HubApiError) throw error
        after = lastSeen
      }
      const run = await hub.getRun(id)
      if (run.status === "disconnected") {
        console.error(
          `run ${id} disconnected; recover it with POST /v1/runs/${id}/recover then follow again`,
        )
        process.exit(3)
      }
      if (FOLLOW_STOP_STATUSES.has(run.status)) return
      if (after > before) attempt = 0
      await reconnectDelay(attempt)
      attempt += 1
    }
  }

  throw new Error(USAGE)
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof HubApiError) {
      console.error(`${error.code}: ${error.message}`)
      process.exit(1)
    }
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
