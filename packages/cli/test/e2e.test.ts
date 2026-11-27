import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { canonicalString } from "@agenticform/protocol/canonical"
import { HubClient } from "@agenticform/client"

const root = join(import.meta.dir, "..", "..", "..")
const TOKEN = "e2e-admin-token-0123456789abcdef01"
let hub: ChildProcess
let url = ""
const stateFile = join(mkdtempSync(join(tmpdir(), "af-e2e-")), "hub.sqlite")

const env = (): Record<string, string> => ({
  ...process.env as Record<string, string>,
  AGENTICFORM_ADMIN_TOKEN: TOKEN,
  AGENTICFORM_HUB_URL: url,
})

beforeAll(async () => {
  const child = spawn(process.execPath, ["run", join(root, "packages/hub/bin/hub.ts")], {
    env: {
      ...process.env,
      AGENTICFORM_ADMIN_TOKEN: TOKEN,
      AGENTICFORM_HUB_PORT: "0",
      AGENTICFORM_HUB_DB: stateFile,
      AGENTICFORM_STATE_DIR: join(stateFile, ".."),
    } as Record<string, string>,
    stdio: ["ignore", "pipe", "inherit"],
  })
  hub = child
  url = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(new Error(`hub did not start: ${output}`)), 10_000)
    child.stdout?.on("data", (chunk) => {
      output += String(chunk)
      const match = /hub listening on (\S+)/.exec(output)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.on("exit", (code) => reject(new Error(`hub exited ${code}: ${output}`)))
  })
})

afterAll(async () => {
  if (!hub) return
  const exited = new Promise<void>((resolve) => hub.once("exit", () => resolve()))
  hub.kill("SIGTERM")
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
  rmSync(dirname(stateFile), { recursive: true, force: true })
})

const admin = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** Enroll one node through the real HTTP API and bring it online. */
async function enrollOnlineNode(): Promise<string> {
  const issued = (await (await admin("POST", "/v1/enrollment-tokens")).json()) as { token: string }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const enrolled = (await (
    await admin("POST", "/v1/enroll", {
      token: issued.token,
      name: "e2e-node",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      protocolVersion: 1,
      harnesses: ["codex"],
      labels: {},
    })
  ).json()) as { nodeId: string }

  const body = JSON.stringify({
    protocolVersion: 1,
    harnesses: ["codex"],
    capabilities: ["git"],
    capacity: { slots: 2, inUse: 0 },
    runtimes: [],
  })
  const timestamp = String(Date.now())
  const nonce = randomBytes(16).toString("hex")
  const signature = cryptoSign(
    null,
    Buffer.from(
      canonicalString({
        nodeId: enrolled.nodeId,
        timestampMs: timestamp,
        nonce,
        method: "POST",
        path: "/v1/node/heartbeat",
        body,
      }),
    ),
    privateKey,
  ).toString("base64")
  const heartbeat = await fetch(url + "/v1/node/heartbeat", {
    method: "POST",
    headers: {
      "x-af-node-id": enrolled.nodeId,
      "x-af-timestamp": timestamp,
      "x-af-nonce": nonce,
      "x-af-signature": signature,
      "content-type": "application/json",
    },
    body,
  })
  expect(heartbeat.status).toBe(200)
  return enrolled.nodeId
}

function cli(args: string[], overrides: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run", join(root, "packages/cli/bin/af.ts"), ...args], {
      env: { ...env(), ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ code: -1, out: `${out}\n[timed out]` })
    }, 15_000)
    child.stdout?.on("data", (chunk) => (out += String(chunk)))
    child.stderr?.on("data", (chunk) => (out += String(chunk)))
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out })
    })
  })
}

function cliWithStdin(
  args: string[],
  stdinText: string,
  overrides: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run", join(root, "packages/cli/bin/af.ts"), ...args], {
      env: { ...env(), ...overrides },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ code: -1, out: `${out}\n[timed out]` })
    }, 15_000)
    child.stdout?.on("data", (chunk) => (out += String(chunk)))
    child.stderr?.on("data", (chunk) => (out += String(chunk)))
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out })
    })
    child.stdin?.end(stdinText)
  })
}

interface Mcp {
  request(method: string, params?: unknown): Promise<any>
  close(): void
}

function mcp(overrides: Record<string, string> = {}): Mcp {
  const child = spawn(process.execPath, ["run", join(root, "packages/mcp/bin/mcp.ts")], {
    env: { ...env(), ...overrides },
    stdio: ["pipe", "pipe", "inherit"],
  })
  let buffer = ""
  const pending = new Map<number, (value: any) => void>()
  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk)
    let lineEnd: number
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd)
      buffer = buffer.slice(lineEnd + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })
  let nextId = 1
  return {
    request(method, params) {
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      })
    },
    close() {
      child.kill("SIGTERM")
    },
  }
}

const parse = (out: string): any => JSON.parse(out)

describe("thin clients over the hub HTTP API", () => {
  test("HTTP, CLI and MCP see the same run, cancel and events", async () => {
    const nodeId = await enrollOnlineNode()
    const client = new HubClient({ url, token: TOKEN })
    const request = { idempotencyKey: "parity-1", harness: "codex", prompt: "fix tests", nodeId }

    const viaHttp = await client.createRun(request)

    const started = await cli([
      "run", "start", "--key", "parity-1", "--harness", "codex", "--prompt", "fix tests", "--node", nodeId,
      
    ])
    if (started.code !== 0) throw new Error(`cli failed: ${started.out}`)
    expect(parse(started.out).runId).toBe(viaHttp.runId)

    const server = mcp()
    try {
      await server.request("initialize", { protocolVersion: "2024-11-05" })
      const listed = await server.request("tools/list")
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "list_nodes", "start_run", "get_run", "list_events", "cancel_run",
        "list_permissions", "answer_permission",
        "start_workflow", "get_workflow", "list_workflows", "cancel_workflow",
      ])
      const mcpStart = await server.request("tools/call", { name: "start_run", arguments: request })
      expect(JSON.parse(mcpStart.result.content[0].text).runId).toBe(viaHttp.runId)

      expect((await client.getRun(viaHttp.runId)).status).toBe("queued")
      expect(parse((await cli(["run", "get", viaHttp.runId])).out).status).toBe("queued")
      const mcpGet = await server.request("tools/call", {
        name: "get_run", arguments: { runId: viaHttp.runId },
      })
      expect(JSON.parse(mcpGet.result.content[0].text).status).toBe("queued")

      const cancelled = parse((await cli(["run", "cancel", viaHttp.runId])).out)
      expect(cancelled.status).toBe("cancelled")
      const mcpCancel = await server.request("tools/call", {
        name: "cancel_run", arguments: { runId: viaHttp.runId },
      })
      expect(JSON.parse(mcpCancel.result.content[0].text).status).toBe("cancelled")

      const events = await client.getEvents(viaHttp.runId, 0)
      expect(events.events).toHaveLength(1)
      expect(events.events[0]?.type).toBe("run.finished")
      expect(parse((await cli(["run", "events", viaHttp.runId])).out).events[0].type).toBe("run.finished")
      const mcpEvents = await server.request("tools/call", {
        name: "list_events", arguments: { runId: viaHttp.runId },
      })
      expect(JSON.parse(mcpEvents.result.content[0].text).events[0].type).toBe("run.finished")
    } finally {
      server.close()
    }
  })

  test("SSE follows from after and resumes with Last-Event-ID", async () => {
    const client = new HubClient({ url, token: TOKEN })
    const nodeId = await enrollOnlineNode()
    const run = await client.createRun({
      idempotencyKey: "parity-sse",
      harness: "codex",
      prompt: "fix tests",
      nodeId,
    })
    await client.cancelRun(run.runId)

    const seen: number[] = []
    const last = await client.followEvents(run.runId, 0, (event) => seen.push(event.seq))
    expect(seen).toEqual([1])
    expect(last).toBe(1)

    const resumed: number[] = []
    await client.followEvents(run.runId, last, (event) => resumed.push(event.seq))
    expect(resumed).toEqual([])
  })

  test("follow stops on a real hub disconnected run", async () => {
    const nodeId = await enrollOnlineNode()
    const client = new HubClient({ url, token: TOKEN })
    const run = await client.createRun({
      idempotencyKey: "parity-disconnected",
      harness: "codex",
      prompt: "fix tests",
      nodeId,
    })
    const revoked = await admin("POST", `/v1/nodes/${nodeId}/revoke`)
    expect(revoked.status).toBe(200)

    const started = Date.now()
    const result = await cli(["run", "events", run.runId, "--follow"])
    expect(result.code).toBe(3)
    expect(result.out).toContain(`run ${run.runId} disconnected; recover it with POST /v1/runs/${run.runId}/recover`)
    expect(Date.now() - started).toBeLessThan(5_000)

    const server = mcp()
    try {
      await server.request("initialize", { protocolVersion: "2024-11-05" })
      const startedMcp = Date.now()
      const response = await server.request("tools/call", {
        name: "list_events",
        arguments: { runId: run.runId, follow: true },
      })
      const page = JSON.parse(response.result.content[0].text)
      expect(page.status).toBe("disconnected")
      expect(page.nextAfter).toBeGreaterThan(0)
      expect(Date.now() - startedMcp).toBeLessThan(5_000)
    } finally {
      server.close()
    }
  })

  test("follow with --after past the disconnected event exits 3 promptly", async () => {
    const nodeId = await enrollOnlineNode()
    const client = new HubClient({ url, token: TOKEN })
    const run = await client.createRun({
      idempotencyKey: "parity-disconnected-after",
      harness: "codex",
      prompt: "fix tests",
      nodeId,
    })
    await admin("POST", `/v1/nodes/${nodeId}/revoke`)
    const events = await client.getEvents(run.runId, 0)
    const seq = events.events.at(-1)?.seq as number
    expect(seq).toBeGreaterThan(0)

    const started = Date.now()
    const result = await cli(["run", "events", run.runId, "--follow", "--after", String(seq)])
    expect(result.code).toBe(3)
    expect(result.out).toContain(`run ${run.runId} disconnected`)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("af run start accepts --git-backed=false", async () => {
    const nodeId = await enrollOnlineNode()
    const result = await cli([
      "run", "start", "--key", "parity-git-backed", "--harness", "codex", "--prompt", "fix tests",
      "--node", nodeId, "--git-backed=false",
    ])
    expect(result.code).toBe(0)
    expect(parse(result.out).runId).toBeTruthy()
  })

  test("the CLI takes the token from env, never argv", async () => {
    const viaArgv = await cli(["nodes", "--token", TOKEN], { AGENTICFORM_ADMIN_TOKEN: "" })
    expect(viaArgv.code).toBe(1)
    expect(viaArgv.out).not.toContain(url)
    const viaEnv = await cli(["nodes"])
    expect(viaEnv.code).toBe(0)
    expect(parse(viaEnv.out)[0].name).toBe("e2e-node")
  })

  test("a runs token drives the CLI and is refused on owner routes", async () => {
    const nodeId = await enrollOnlineNode()
    const issued = (await (
      await admin("POST", "/v1/tokens", { name: "cli-runs", scope: "runs" })
    ).json()) as { id: string; token: string }
    const runsEnv = { AGENTICFORM_ADMIN_TOKEN: "", AGENTICFORM_TOKEN: issued.token }

    const started = await cli(
      ["run", "start", "--key", "runs-token-1", "--harness", "codex", "--prompt", "fix tests", "--node", nodeId],
      runsEnv,
    )
    expect(started.code).toBe(0)
    const runId = parse(started.out).runId as string

    expect(parse((await cli(["run", "get", runId], runsEnv)).out).status).toBe("queued")
    expect(parse((await cli(["run", "cancel", runId], runsEnv)).out).status).toBe("cancelled")
    const followed = await cli(["run", "events", runId, "--follow"], runsEnv)
    expect(followed.code).toBe(0)
    expect(followed.out).toContain("run.finished")

    const refused = await cli(["token", "list"], runsEnv)
    expect(refused.code).toBe(1)
    expect(refused.out).toContain("forbidden")

    // The admin token still lists tokens.
    const listed = await cli(["token", "list"])
    expect(listed.code).toBe(0)
    expect(parse(listed.out).some((token: { name: string }) => token.name === "cli-runs")).toBe(true)
  })

  test("HTTP, CLI, script, and MCP share workflow parity", async () => {
    await enrollOnlineNode()
    const started = await cli([
      "workflow", "start", "--key", "e2e-wf-1", "--code", "return (await af.listNodes()).length",
    ])
    expect(started.code).toBe(0)
    const wf = parse(started.out)
    expect(wf.workflowId).toBeTruthy()

    const listed = await cli(["workflow", "list"])
    expect(listed.code).toBe(0)
    expect(parse(listed.out).some((item: { workflowId: string }) => item.workflowId === wf.workflowId)).toBe(true)

    const fetched = await cli(["workflow", "get", wf.workflowId])
    expect(fetched.code).toBe(0)

    const localScript = await cli([
      "script", "run", "--code", "return (await af.listNodes()).length",
    ])
    expect(localScript.code).toBe(0)
    expect(parse(localScript.out)).toMatchObject({ ok: true })

    const server = mcp()
    try {
      await server.request("initialize", { protocolVersion: "2024-11-05" })
      const mcpStart = await server.request("tools/call", {
        name: "start_workflow",
        arguments: { idempotencyKey: "e2e-wf-1", code: "return (await af.listNodes()).length" },
      })
      expect(JSON.parse(mcpStart.result.content[0].text).workflowId).toBe(wf.workflowId)

      const mcpGet = await server.request("tools/call", {
        name: "get_workflow",
        arguments: { workflowId: wf.workflowId },
      })
      expect(JSON.parse(mcpGet.result.content[0].text).workflowId).toBe(wf.workflowId)
    } finally {
      server.close()
    }
  })

  test("af init and af config drive CLI and MCP without AGENTICFORM_HUB_URL or token env vars", async () => {
    await enrollOnlineNode()
    const cfgDir = mkdtempSync(join(tmpdir(), "af-cli-cfg-"))
    const cfgFile = join(cfgDir, "config.json")
    const noAuthEnv = {
      AGENTICFORM_CONFIG: cfgFile,
      AGENTICFORM_HUB_URL: "",
      AGENTICFORM_ADMIN_TOKEN: "",
      AGENTICFORM_TOKEN: "",
    }
    try {
      const initHub = await cli(["init", "hub", "--port", "9012"], noAuthEnv)
      expect(initHub.code).toBe(0)
      expect(parse(initHub.out)).toMatchObject({ role: "hub", port: 9012, adminTokenGenerated: true })

      // Refuse secret on argv.
      const argSecret = await cli(["config", "set", "token", "leaked-on-argv"], noAuthEnv)
      expect(argSecret.code).toBe(1)
      expect(argSecret.out).toContain("stdin")

      // Initialize client with real hub URL and token via stdin.
      const initClient = await cliWithStdin(["init", "client", "--url", url], `${TOKEN}\n`, noAuthEnv)
      expect(initClient.code).toBe(0)
      expect(parse(initClient.out)).toMatchObject({ role: "client", hubUrl: url, tokenConfigured: true })
      expect(initClient.out).not.toContain(TOKEN)

      const clearedAdmin = await cli(["config", "unset", "adminToken"], noAuthEnv)
      expect(clearedAdmin.code).toBe(0)

      const shown = await cli(["config", "show"], noAuthEnv)
      expect(shown.code).toBe(0)
      expect(shown.out).not.toContain(TOKEN)
      expect(parse(shown.out).values.token).toEqual({ value: "***", source: "file" })

      // Both CLI and MCP now talk to the real hub with zero URL/token env vars.
      const nodesRes = await cli(["nodes"], noAuthEnv)
      expect(nodesRes.code).toBe(0)
      expect(parse(nodesRes.out).length).toBeGreaterThan(0)

      const server = mcp(noAuthEnv)
      try {
        await server.request("initialize", { protocolVersion: "2024-11-05" })
        const listed = await server.request("tools/call", { name: "list_nodes", arguments: {} })
        expect(JSON.parse(listed.result.content[0].text).length).toBeGreaterThan(0)
      } finally {
        server.close()
      }
    } finally {
      rmSync(cfgDir, { recursive: true, force: true })
    }
  })
})
