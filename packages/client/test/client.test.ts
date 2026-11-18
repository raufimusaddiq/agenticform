import { afterAll, describe, expect, test } from "bun:test"
import { HubApiError, HubClient, normalizeAfter, reconnectDelay } from "../src/index.ts"

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

describe("resume cursor", () => {
  test("accepts non-negative integers", () => {
    expect(normalizeAfter(0)).toBe(0)
    expect(normalizeAfter("3")).toBe(3)
  })

  test("rejects negative, fractional and non-numeric values", () => {
    for (const value of [-1, 1.5, "x", "", null]) {
      expect(() => normalizeAfter(value)).toThrow("after must be a non-negative integer")
    }
  })
})

describe("reconnect backoff", () => {
  test("is bounded and gives up after the retry cap", async () => {
    await expect(reconnectDelay(6)).rejects.toThrow("did not advance after 5 retries")
  })
})
