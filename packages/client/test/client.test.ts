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
