import { afterAll, describe, expect, test } from "bun:test"
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
    if (url.pathname === "/v1/runs/r1") {
      return Response.json({
        runId: "r1",
        status: streams >= 2 ? "cancelled" : "queued",
        nodeId: null,
        generation: 1,
        createdAt: new Date().toISOString(),
      })
    }
    return new Response("not found", { status: 404 })
  },
})

afterAll(() => server.stop(true))

function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run", bin, ...args], {
      env: {
        ...process.env,
        AGENTICFORM_HUB_URL: server.url.origin,
        AGENTICFORM_ADMIN_TOKEN: "test-token",
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
})
