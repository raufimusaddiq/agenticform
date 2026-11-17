#!/usr/bin/env bun
import type { RunRequest } from "@agenticform/protocol"
import { HubApiError, HubClient } from "@agenticform/client"

const USAGE = `usage: af <command>
  af nodes
  af run start --harness <h> --prompt <text> --key <idempotency-key>
               [--cwd <dir>] [--node <id>] [--requires a,b] [--label k=v]...
  af run get <runId>
  af run events <runId> [--after <seq>] [--follow]
  af run cancel <runId>

Environment: AGENTICFORM_HUB_URL, AGENTICFORM_ADMIN_TOKEN`

function client(): HubClient {
  const url = process.env.AGENTICFORM_HUB_URL
  const token = process.env.AGENTICFORM_ADMIN_TOKEN
  if (!url) throw new Error("AGENTICFORM_HUB_URL is required")
  if (!token) throw new Error("AGENTICFORM_ADMIN_TOKEN is required")
  return new HubClient({ url, token })
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

function flags(args: string[], name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined) values.push(args[i + 1] as string)
  }
  return values
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
    const labels: Record<string, string> = {}
    for (const label of flags(rest, "label")) {
      const [key, value] = label.split("=")
      if (key && value !== undefined) labels[key] = value
    }
    const request: RunRequest = {
      idempotencyKey,
      harness,
      prompt,
      ...(flag(rest, "cwd") === undefined ? {} : { cwd: flag(rest, "cwd") as string }),
      ...(flag(rest, "node") === undefined ? {} : { nodeId: flag(rest, "node") as string }),
      ...(requires === undefined ? {} : { requires: requires.split(",").filter(Boolean) }),
      ...(Object.keys(labels).length ? { labels } : {}),
    }
    return print(await hub.createRun(request))
  }

  if (group === "run" && action === "get" && id) return print(await hub.getRun(id))
  if (group === "run" && action === "cancel" && id) return print(await hub.cancelRun(id))

  if (group === "run" && action === "events" && id) {
    let after = Number(flag(rest, "after") ?? 0)
    if (!rest.includes("--follow")) {
      const page = await hub.getEvents(id, after)
      return print(page)
    }
    while (true) {
      after = await hub.followEvents(id, after, (event) => print(event))
      const run = await hub.getRun(id)
      if (["completed", "failed", "cancelled"].includes(run.status)) return
    }
  }

  throw new Error(USAGE)
}

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
