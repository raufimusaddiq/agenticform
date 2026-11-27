#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
import type { RunRequest, WorkflowLimits, WorkflowRequest } from "@agenticform/protocol"
import {
  FOLLOW_STOP_STATUSES,
  HubApiError,
  HubClient,
  envToken,
  normalizeAfter,
  reconnectDelay,
} from "@agenticform/client"
import { createScriptRuntime, type Json } from "@agenticform/script"

const USAGE = `usage: af <command>
  af nodes
  af run start --harness <h> --prompt <text> --key <idempotency-key>
               [--cwd <dir>] [--node <id>] [--requires a,b] [--label k=v]...
               [--git-backed[=true|false]] [--parent <runId>]
               [--permissions allow|ask|deny]   (default allow; the sandbox is the boundary)
  af run get <runId>
  af run events <runId> [--after <seq>] [--follow]
  af run cancel <runId>
  af run permissions <runId>
  af run answer <runId> <requestId> allow|deny
  af workflow start --key <idempotency-key> (--code <js> | --file <path>)
                    [--parent <runId>] [--timeout-ms <ms>] [--max-output-bytes <n>]
                    [--max-snapshot-bytes <n>] [--max-child-runs <n>]
  af workflow list
  af workflow get <workflowId>
  af workflow cancel <workflowId>
  af script run (--code <js> | --file <path>) [--parent <runId>]
                [--timeout-ms <ms>] [--max-output-bytes <n>]
                [--max-snapshot-bytes <n>] [--max-child-runs <n>]
                [--state-out <file>]
  af script resume --state <file> [--state-out <file>]
  af token issue <name>
  af token list
  af token revoke <id>

Flags also accept --flag=value. Use that form when a value starts with "--".

Environment: AGENTICFORM_HUB_URL, AGENTICFORM_ADMIN_TOKEN or AGENTICFORM_TOKEN`

function client(): HubClient {
  const url = process.env.AGENTICFORM_HUB_URL
  const token = envToken()
  if (!url) throw new Error("AGENTICFORM_HUB_URL is required")
  if (!token) throw new Error("AGENTICFORM_ADMIN_TOKEN or AGENTICFORM_TOKEN is required")
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

function parseOptionalIntFlag(rest: string[], name: string, min: number): number | undefined {
  const raw = flag(rest, name)
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be an integer >= ${min}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`)
  return value
}

function parseWorkflowLimits(rest: string[]): WorkflowLimits | undefined {
  const timeoutMs = parseOptionalIntFlag(rest, "timeout-ms", 1)
  const maxOutputBytes = parseOptionalIntFlag(rest, "max-output-bytes", 0)
  const maxSnapshotBytes = parseOptionalIntFlag(rest, "max-snapshot-bytes", 1)
  const maxChildRuns = parseOptionalIntFlag(rest, "max-child-runs", 0)
  if (
    timeoutMs === undefined &&
    maxOutputBytes === undefined &&
    maxSnapshotBytes === undefined &&
    maxChildRuns === undefined
  ) {
    return undefined
  }
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes }),
    ...(maxChildRuns === undefined ? {} : { maxChildRuns }),
  }
}

function readScriptSource(rest: string[]): string {
  const code = flag(rest, "code")
  const file = flag(rest, "file")
  if (code !== undefined && file !== undefined) {
    throw new Error("pass either --code or --file, not both")
  }
  if (code !== undefined) return code
  if (file !== undefined) return readFileSync(file, "utf8")
  throw new Error("--code or --file is required")
}

/** Reject unknown --flags; booleans are listed too. */
function rejectUnknownFlags(args: string[], allowed: readonly string[]): void {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue
    const name = arg.slice(2).split("=")[0] as string
    if (!allowed.includes(name)) throw new Error(`unknown flag --${name}\n\n${USAGE}`)
  }
}

async function main(argv: string[]): Promise<void> {
  const [group, action, id] = argv

  if (group === "nodes") {
    rejectUnknownFlags(argv.slice(1), [])
    return print(await client().listNodes())
  }

  if (group === "token") {
    rejectUnknownFlags(argv.slice(1), [])
    if (action === "issue") {
      if (!id) throw new Error("af token issue <name>")
      return print(await client().issueToken(id))
    }
    if (action === "list") return print(await client().listTokens())
    if (action === "revoke") {
      if (!id) throw new Error("af token revoke <id>")
      return print(await client().revokeToken(id))
    }
    throw new Error(USAGE)
  }

  if (group === "workflow") {
    const rest = argv.slice(2)
    if (action === "start") {
      rejectUnknownFlags(rest, [
        "key",
        "code",
        "file",
        "parent",
        "timeout-ms",
        "max-output-bytes",
        "max-snapshot-bytes",
        "max-child-runs",
      ])
      const idempotencyKey = flag(rest, "key")
      if (!idempotencyKey) throw new Error("--key is required")
      const code = readScriptSource(rest)
      const parentRunId = flag(rest, "parent")
      const limits = parseWorkflowLimits(rest)
      const request: WorkflowRequest = {
        idempotencyKey,
        code,
        ...(parentRunId === undefined ? {} : { parentRunId }),
        ...(limits === undefined ? {} : { limits }),
      }
      return print(await client().createWorkflow(request))
    }
    if (action === "list") {
      rejectUnknownFlags(rest, [])
      return print(await client().listWorkflows())
    }
    if (action === "get") {
      rejectUnknownFlags(rest, [])
      if (!id) throw new Error("af workflow get <workflowId>")
      return print(await client().getWorkflow(id))
    }
    if (action === "cancel") {
      rejectUnknownFlags(rest, [])
      if (!id) throw new Error("af workflow cancel <workflowId>")
      return print(await client().cancelWorkflow(id))
    }
    throw new Error(USAGE)
  }

  if (group === "script") {
    const rest = argv.slice(2)
    if (action === "run") {
      rejectUnknownFlags(rest, [
        "code",
        "file",
        "parent",
        "timeout-ms",
        "max-output-bytes",
        "max-snapshot-bytes",
        "max-child-runs",
        "state-out",
      ])
      const code = readScriptSource(rest)
      const parentRunId = flag(rest, "parent")
      const limits = parseWorkflowLimits(rest)
      const stateOut = flag(rest, "state-out")
      const runtime = createScriptRuntime(client(), {
        ...(limits === undefined ? {} : { limits }),
        ...(parentRunId === undefined ? {} : { parentRunId }),
      })
      const program = runtime.program(code)
      const controller = new AbortController()
      let suspendedBySignal = false
      const onSignal = (): void => {
        if (stateOut) {
          if (!suspendedBySignal) {
            suspendedBySignal = true
            void program.suspend().then((outcome) => {
              if (outcome.ok === "suspended") writeFileSync(stateOut, outcome.bytes)
            })
          }
          return
        }
        controller.abort("SIGINT")
      }
      process.once("SIGINT", onSignal)
      try {
        const outcome = await program.run({ signal: controller.signal })
        if (outcome.ok === "suspended") {
          if (stateOut) writeFileSync(stateOut, outcome.bytes)
          return print({ ok: "suspended", stateFile: stateOut ?? null, bytes: outcome.bytes.length })
        }
        print(outcome)
        if (!outcome.ok) process.exit(1)
        return
      } finally {
        process.off("SIGINT", onSignal)
      }
    }
    if (action === "resume") {
      rejectUnknownFlags(rest, ["state", "state-out"])
      const stateFile = flag(rest, "state")
      if (!stateFile) throw new Error("--state is required")
      const stateOut = flag(rest, "state-out") ?? stateFile
      const bytes = new Uint8Array(readFileSync(stateFile))
      const runtime = createScriptRuntime(client())
      const program = runtime.resume(bytes)
      let suspendedBySignal = false
      const onSignal = (): void => {
        if (!suspendedBySignal) {
          suspendedBySignal = true
          void program.suspend().then((outcome) => {
            if (outcome.ok === "suspended") writeFileSync(stateOut, outcome.bytes)
          })
        }
      }
      process.once("SIGINT", onSignal)
      try {
        const outcome = await program.run()
        if (outcome.ok === "suspended") {
          writeFileSync(stateOut, outcome.bytes)
          return print({ ok: "suspended", stateFile: stateOut, bytes: outcome.bytes.length })
        }
        print(outcome)
        if (!outcome.ok) process.exit(1)
        return
      } finally {
        process.off("SIGINT", onSignal)
      }
    }
    throw new Error(USAGE)
  }

  if (group === "run" && action === "start") {
    const rest = argv.slice(2)
    rejectUnknownFlags(rest, ["harness", "prompt", "key", "cwd", "node", "requires", "label", "git-backed", "parent", "permissions"])
    const harness = flag(rest, "harness")
    const prompt = flag(rest, "prompt")
    const idempotencyKey = flag(rest, "key")
    if (!harness || !prompt || !idempotencyKey) throw new Error("--harness, --prompt and --key are required")
    const requires = flag(rest, "requires")
    const cwd = flag(rest, "cwd")
    const node = flag(rest, "node")
    const parent = flag(rest, "parent")
    const labels = parseLabels(flags(rest, "label"))
    const permissions = flag(rest, "permissions")
    if (permissions !== undefined && permissions !== "allow" && permissions !== "ask" && permissions !== "deny") {
      throw new Error("--permissions must be allow, ask or deny")
    }
    const gitBackedFlag = rest.find((arg) => arg === "--git-backed" || arg.startsWith("--git-backed="))
    let gitBacked: boolean | undefined
    if (gitBackedFlag !== undefined) {
      if (gitBackedFlag === "--git-backed") {
        // Bare --git-backed means true. A space-separated value would be
        // silently ignored, so reject it and point at the = form.
        const next = rest[rest.indexOf("--git-backed") + 1]
        if (next === "true" || next === "false") {
          throw new Error(`--git-backed takes no space-separated value; use --git-backed=${next}`)
        }
        gitBacked = true
      } else {
        const value = gitBackedFlag.slice("--git-backed=".length)
        if (value !== "true" && value !== "false") throw new Error("--git-backed must be true or false")
        gitBacked = value === "true"
      }
    }
    const request: RunRequest = {
      idempotencyKey,
      harness,
      prompt,
      ...(cwd === undefined ? {} : { cwd }),
      ...(node === undefined ? {} : { nodeId: node }),
      ...(requires === undefined ? {} : { requires: requires.split(",").filter(Boolean) }),
      ...(Object.keys(labels).length ? { labels } : {}),
      ...(gitBacked === undefined ? {} : { gitBacked }),
      ...(parent === undefined ? {} : { parentRunId: parent }),
      ...(permissions === undefined ? {} : { permissionPolicy: permissions }),
    }
    return print(await client().createRun(request))
  }

  if (group === "run" && action === "permissions") {
    const rest = argv.slice(2)
    rejectUnknownFlags(rest, [])
    const runId = rest[0]
    if (!runId) throw new Error("af run permissions <runId>")
    return print(await client().listPermissions(runId))
  }

  if (group === "run" && action === "answer") {
    const rest = argv.slice(2)
    rejectUnknownFlags(rest, [])
    const [runId, requestId, decision] = rest
    if (!runId || !requestId) throw new Error("af run answer <runId> <requestId> allow|deny")
    if (decision !== "allow" && decision !== "deny") throw new Error("decision must be allow or deny")
    return print(await client().answerPermission(runId, requestId, decision))
  }

  if (group !== "run" || !action || !id || !["get", "events", "cancel"].includes(action)) {
    throw new Error(USAGE)
  }

  const rest = argv.slice(3)
  if (action === "get" || action === "cancel") {
    rejectUnknownFlags(rest, [])
    const hub = client()
    return print(action === "get" ? await hub.getRun(id) : await hub.cancelRun(id))
  }

  rejectUnknownFlags(rest, ["after", "follow"])
  const hub = client()
  let after = normalizeAfter(flag(rest, "after") ?? 0)
  if (!rest.includes("--follow")) {
    const page = await hub.getEvents(id, after)
    return print(page)
  }
  let lastSeen = after
  let attempt = 0
  while (true) {
    // Check before every stream open: a disconnected run's stream stays open
    // and never replays the event when `after` is already past it.
    const run = await hub.getRun(id)
    if (run.status === "disconnected") {
      // Drain history first: the stream stays open and never replays events
      // already past `after`, so a bare exit would drop them.
      const page = await hub.getEvents(id, after)
      for (const event of page.events) print(event)
      console.error(
        `run ${id} disconnected; recover it with POST /v1/runs/${id}/recover then follow again`,
      )
      process.exit(3)
    }
    if (FOLLOW_STOP_STATUSES.has(run.status)) {
      const page = await hub.getEvents(id, after)
      for (const event of page.events) print(event)
      return
    }

    const before = after
    const controller = new AbortController()
    let aborted = false
    try {
      lastSeen = await hub.followEvents(
        id,
        after,
        (event) => {
          lastSeen = event.seq
          print(event)
          // The hub keeps the stream open after run.disconnected; stop here.
          if (event.type === "run.disconnected") {
            aborted = true
            controller.abort()
          }
        },
        controller.signal,
      )
      after = lastSeen
    } catch (error) {
      // A dropped connection is no progress: back off, then resume from the last seq seen.
      if (error instanceof HubApiError) throw error
      after = lastSeen
    }
    // Aborted on run.disconnected: re-check the run now instead of sleeping.
    if (aborted) continue
    if (after > before) attempt = 0
    await reconnectDelay(attempt)
    attempt += 1
  }
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
