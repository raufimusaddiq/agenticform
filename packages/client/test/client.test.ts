import { afterAll, describe, expect, test } from "bun:test"
import {
  FOLLOW_STOP_STATUSES,
  HubApiError,
  HubClient,
  TERMINAL_WORKFLOW_STATUSES,
  normalizeAfter,
  reconnectDelay,
} from "../src/index.ts"

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/v1/nodes") {
      return new Response("<html><body>bad gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })
    }
    if (path === "/v1/runs/missing") {
      return Response.json({ error: { code: "not_found", message: "run not found" } }, { status: 404 })
    }
    if (path === "/v1/runs/truncated") {
      return new Response('{"runId": "r1", "sta', { status: 200 })
    }
    if (path === "/v1/runs/empty") {
      return new Response("", { status: 200 })
    }
    return new Response("not found", { status: 404 })
  },
})

afterAll(() => server.stop(true))

const client = new HubClient({ url: server.url.origin, token: "test-token" })

describe("error responses", () => {
  test("a non-JSON 502 body still becomes a HubApiError with status and fallback code", async () => {
    const error = await client.listNodes().catch((caught) => caught)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.status).toBe(502)
    expect(error.code).toBe("internal")
    expect(error.message).toBe("Bad Gateway")
  })

  test("a JSON error keeps the hub's code and message", async () => {
    const error = await client.getRun("missing").catch((caught) => caught)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("run not found")
  })

  test("a truncated 2xx body is an internal HubApiError, not undefined", async () => {
    const error = await client.getRun("truncated").catch((caught) => caught)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.status).toBe(200)
    expect(error.code).toBe("internal")
    expect(error.message).toBe("hub returned a non-JSON body with status 200")
  })

  test("an empty 2xx body is an internal HubApiError", async () => {
    const error = await client.getRun("empty").catch((caught) => caught)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.code).toBe("internal")
    expect(error.message).toBe("hub returned a non-JSON body with status 200")
  })

  test("a long non-JSON error body is truncated in the message", async () => {
    const longClient = new HubClient({
      url: "http://127.0.0.1:1",
      token: "t",
      fetch: async () => new Response("x".repeat(500), { status: 502, statusText: "" }),
    })
    const error = await longClient.listNodes().catch((caught) => caught)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.message).toBe(`${"x".repeat(200)}…`)
  })
})

describe("resume cursor", () => {  test("accepts non-negative integers", () => {
    expect(normalizeAfter(0)).toBe(0)
    expect(normalizeAfter("3")).toBe(3)
  })

  test("rejects negative, fractional and non-numeric values", () => {
    for (const value of [-1, 1.5, "x", "", null, "0x10", "1e3", " 1"]) {
      expect(() => normalizeAfter(value)).toThrow("after must be a non-negative integer")
    }
  })
})

describe("reconnect backoff", () => {
  test("is bounded and gives up after exactly MAX_FOLLOW_RETRIES retries", async () => {
    await expect(reconnectDelay(5)).rejects.toThrow("did not advance after 5 retries")
    await reconnectDelay(0)
  })
})

describe("follow stop statuses", () => {
  test("stops on terminal statuses and disconnected, not on running", () => {
    expect(FOLLOW_STOP_STATUSES.has("completed")).toBe(true)
    expect(FOLLOW_STOP_STATUSES.has("failed")).toBe(true)
    expect(FOLLOW_STOP_STATUSES.has("cancelled")).toBe(true)
    expect(FOLLOW_STOP_STATUSES.has("disconnected")).toBe(true)
    expect(FOLLOW_STOP_STATUSES.has("running")).toBe(false)
  })
})

describe("SSE framing", () => {
  test("parses CRLF frames and flushes a final frame without a blank line", async () => {
    const wire = (seq: number): string =>
      `id: ${seq}\ndata: ${JSON.stringify({ seq, key: `k${seq}`, type: "message.delta", at: new Date().toISOString(), data: {} })}`
    const stub = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(`${wire(1).replace(/\n/g, "\r\n")}\r\n\r\n${wire(2)}`, {
          headers: { "content-type": "text/event-stream" },
        }),
    })
    try {
      const sseClient = new HubClient({ url: stub.url.origin, token: "t" })
      const seen: number[] = []
      const last = await sseClient.followEvents("r1", 0, (event) => seen.push(event.seq))
      expect(seen).toEqual([1, 2])
      expect(last).toBe(2)
    } finally {
      stub.stop(true)
    }
  })
})

describe("listNodes", () => {
  test("treats a 204 as an empty list", async () => {
    const stub = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) })
    try {
      const emptyClient = new HubClient({ url: stub.url.origin, token: "t" })
      expect(await emptyClient.listNodes()).toEqual([])
    } finally {
      stub.stop(true)
    }
  })
})

describe("workflows", () => {
  test("TERMINAL_WORKFLOW_STATUSES and workflow client endpoints round-trip", async () => {
    expect(TERMINAL_WORKFLOW_STATUSES.has("completed")).toBe(true)
    expect(TERMINAL_WORKFLOW_STATUSES.has("failed")).toBe(true)
    expect(TERMINAL_WORKFLOW_STATUSES.has("cancelled")).toBe(true)
    expect(TERMINAL_WORKFLOW_STATUSES.has("suspended")).toBe(false)

    const workflow = {
      workflowId: "wf-1",
      status: "completed",
      parentRunId: null,
      depth: 0,
      result: { ok: true },
      childRunIds: [],
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
      completedAt: "2026-11-27T00:00:00.000Z",
    }
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/v1/workflows" && req.method === "POST") return Response.json(workflow, { status: 201 })
        if (path === "/v1/workflows" && req.method === "GET") return Response.json({ workflows: [workflow] })
        if (path === "/v1/workflows/wf-1" && req.method === "GET") return Response.json(workflow)
        if (path === "/v1/workflows/wf-1/cancel" && req.method === "POST") {
          return Response.json({ ...workflow, status: "cancelled" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    try {
      const wfClient = new HubClient({ url: stub.url.origin, token: "t" })
      expect((await wfClient.createWorkflow({ idempotencyKey: "k1", code: "return 1" })).workflowId).toBe("wf-1")
      expect(await wfClient.listWorkflows()).toHaveLength(1)
      expect((await wfClient.getWorkflow("wf-1")).status).toBe("completed")
      expect((await wfClient.cancelWorkflow("wf-1")).status).toBe("cancelled")
    } finally {
      stub.stop(true)
    }
  })
})
