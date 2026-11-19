import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"

const bin = join(import.meta.dir, "..", "bin", "af.ts")
const encoder = new TextEncoder()
const event = (seq: number, type: string): string =>
  `id: ${seq}\ndata: ${JSON.stringify({ seq, key: `k${seq}`, type, at: new Date().toISOString(), data: {} })}\n\n`

const resumes: (string | null)[] = []
let streams = 0

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/v1/runs/r1/events") {
      if (url.searchParams.get("stream") !== "sse") {
        return Response.json({ events: [], lastSeq: Number(url.searchParams.get("after") ?? 0) })
      }
      streams += 1
      resumes.push(request.headers.get("last-event-id"))
      if (streams === 1) {
        // Send one event, then drop the connection mid-stream.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(event(1, "message.delta")))
              setTimeout(() => controller.error(new Error("connection dropped")), 10)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(event(2, "run.finished")))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/v1/runs/d1/events") {
      if (url.searchParams.get("stream") !== "sse") {
        return Response.json({
          events: [{ seq: 1, key: "k1", type: "run.disconnected", at: new Date().toISOString(), data: {} }],
          lastSeq: 1,
        })
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(event(1, "run.disconnected")))
            // The real hub keeps the stream open after run.disconnected.
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/v1/runs/t1/events") {
      return Response.json({
        events: [{ seq: 1, key: "k1", type: "run.finished", at: new Date().toISOString(), data: {} }],
        lastSeq: 1,
      })
    }
    if (url.pathname === "/v1/runs/t1") {
      return Response.json({
        runId: "t1",
        status: "completed",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
      })
    }
    if (url.pathname === "/v1/runs/d1") {
      return Response.json({
        runId: "d1",
        status: "disconnected",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
      })
    }
    if (url.pathname === "/v1/runs/r1") {
      return Response.json({
        runId: "r1",
        status: streams >= 2 ? "cancelled" : "queued",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
      })
    }
    if (url.pathname === "/v1/runs/r1/permissions") {
      return Response.json({
        permissions: [
          {
            requestId: "call_7",
            generation: 1,
            title: "Write file",
            kind: "edit",
            options: ["allow", "deny"],
            status: "pending",
            decision: null,
            requestedAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
          },
        ],
      })
    }
    if (url.pathname === "/v1/runs/r1/permissions/call_7" && request.method === "POST") {
      return Response.json({
        requestId: "call_7",
        generation: 1,
        title: "Write file",
        kind: "edit",
        options: ["allow", "deny"],
        status: "answered",
        decision: "allow",
        requestedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      })
    }
    return new Response("not found", { status: 404 })
  },
})

afterAll(() => server.stop(true))

beforeEach(() => {
  streams = 0
  resumes.length = 0
})

function cli(args: string[], overrides: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run", bin, ...args], {
      env: {
        ...process.env,
        AGENTICFORM_HUB_URL: server.url.origin,
        AGENTICFORM_ADMIN_TOKEN: "test-token",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout?.on("data", (chunk) => (out += String(chunk)))
    child.stderr?.on("data", (chunk) => (err += String(chunk)))
    child.on("exit", (code) => resolve({ code: code ?? -1, out, err }))
  })
}

describe("af run events --follow", () => {
  test("backs off after a dropped stream and resumes from the last seq", async () => {
    const result = await cli(["run", "events", "r1", "--follow"])
    expect(result.code).toBe(0)
    expect(result.out).toContain('"type": "message.delta"')
    expect(result.out).toContain('"type": "run.finished"')
    expect(resumes).toEqual(["0", "1"])
  })

  test("stops on a disconnected run with exit 3 and a recover hint", async () => {
    const result = await cli(["run", "events", "d1", "--follow"])
    expect(result.code).toBe(3)
    expect(result.out).toContain('"type": "run.disconnected"')
    expect(result.err).toContain(
      "run d1 disconnected; recover it with POST /v1/runs/d1/recover then follow again",
    )
  })

  test("drains history before exiting on a terminal run", async () => {
    const result = await cli(["run", "events", "t1", "--follow"])
    expect(result.code).toBe(0)
    expect(result.out).toContain('"type": "run.finished"')
    expect(streams).toBe(0)
  })

  test("rejects a space-separated --git-backed value", async () => {
    const result = await cli([
      "run", "start", "--key", "k", "--harness", "codex", "--prompt", "p", "--git-backed", "false",
    ])
    expect(result.code).toBe(1)
    expect(result.err).toContain("--git-backed takes no space-separated value; use --git-backed=false")
  })

  test("rejects an unknown --permissions value", async () => {
    const result = await cli(["run", "start", "--key", "k", "--harness", "codex", "--prompt", "p", "--permissions", "yolo"])
    expect(result.code).toBe(1)
    expect(result.err).toContain("--permissions must be allow, ask or deny")
  })

  test("--after rejects a non-negative integer violation", async () => {
    const result = await cli(["run", "events", "r1", "--after", "-1"])
    expect(result.code).toBe(1)
    expect(result.err).toContain("after must be a non-negative integer")
  })

  test("a flag without a value exits non-zero", async () => {
    const result = await cli(["run", "start", "--key", "k", "--harness"])
    expect(result.code).toBe(1)
    expect(result.err).toContain("--harness requires a value")
  })

  test("a flag followed by another flag exits non-zero", async () => {
    const result = await cli(["run", "start", "--key", "k", "--harness", "--prompt", "p"])
    expect(result.code).toBe(1)
    expect(result.err).toContain("--harness requires a value")
  })

  test("accepts --flag=value, including values starting with '--'", async () => {
    const result = await cli([
      "run", "start", "--key=k", "--harness=codex", "--prompt=--literal", "--label", "broken",
    ])
    expect(result.code).toBe(1)
    expect(result.err).toContain('invalid --label "broken": expected key=value')
  })

  test("no command prints usage before requiring env", async () => {
    const result = await cli([], { AGENTICFORM_HUB_URL: "", AGENTICFORM_ADMIN_TOKEN: "" })
    expect(result.code).toBe(1)
    expect(result.err).toContain("usage: af")
    expect(result.err).not.toContain("AGENTICFORM_HUB_URL is required")
  })

  test("an unknown command prints usage before requiring env", async () => {
    const result = await cli(["bogus"], { AGENTICFORM_HUB_URL: "", AGENTICFORM_ADMIN_TOKEN: "" })
    expect(result.code).toBe(1)
    expect(result.err).toContain("usage: af")
    expect(result.err).not.toContain("AGENTICFORM_HUB_URL is required")
  })

  test("an unknown flag exits non-zero with usage", async () => {
    const result = await cli(["run", "start", "--key", "k", "--harness", "codex", "--prompt", "p", "--bogus", "x"])
    expect(result.code).toBe(1)
    expect(result.err).toContain("unknown flag --bogus")
    expect(result.err).toContain("usage: af")
  })
})

describe("af run permissions and answer", () => {
  test("lists a run's permission requests", async () => {
    const result = await cli(["run", "permissions", "r1"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)[0].requestId).toBe("call_7")
  })

  test("answers a request", async () => {
    const result = await cli(["run", "answer", "r1", "call_7", "allow"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out).status).toBe("answered")
  })

  test("rejects a decision that is not allow or deny", async () => {
    const result = await cli(["run", "answer", "r1", "call_7", "maybe"])
    expect(result.code).toBe(1)
    expect(result.err).toContain("decision must be allow or deny")
  })

  test("requires a run id", async () => {
    const result = await cli(["run", "permissions"])
    expect(result.code).toBe(1)
    expect(result.err).toContain("af run permissions <runId>")
  })
})
