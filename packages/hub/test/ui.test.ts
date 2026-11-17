import { afterEach, describe, expect, test } from "bun:test"
import type { Hub } from "../src/index.ts"
import { api, createRun, enroll, heartbeat, nextCommand, signedFetch, startHub } from "./helpers.ts"

let hub: Hub | undefined
afterEach(() => {
  hub?.stop()
  hub = undefined
})

const get = (path: string) => fetch((hub as Hub).url + path)

describe("ui assets", () => {
  test("the page and its assets are served from the hub origin", async () => {
    hub = startHub()
    const page = await get("/")
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'")
    const html = await page.text()
    expect(html).toContain('src="/ui/app.js"')
    expect(html).toContain('href="/ui/app.css"')

    const script = await get("/ui/app.js")
    expect(script.status).toBe(200)
    expect(script.headers.get("content-type")).toContain("text/javascript")
    const js = await script.text()
    expect(js).toContain("authorization")
    // EventSource cannot carry a bearer header, so the UI must not use it.
    expect(js).not.toContain("new EventSource")

    const css = await get("/ui/app.css")
    expect(css.status).toBe(200)
    expect(css.headers.get("content-type")).toContain("text/css")
  })

  test("the token never appears in the page, assets or a URL", async () => {
    hub = startHub()
    const token = hub.config.adminToken
    const bodies = await Promise.all(["/", "/ui/app.js", "/ui/app.css"].map(async (path) => (await get(path)).text()))
    for (const body of bodies) {
      expect(body).not.toContain(token)
      expect(body).not.toContain("?token")
      expect(body).not.toContain("token=")
    }
    // The UI is public, the API is not.
    expect((await get("/v1/nodes")).status).toBe(401)
    expect((await get("/v1/runs/anything")).status).toBe(401)
  })

  test("unknown routes still fail closed", async () => {
    hub = startHub()
    expect((await get("/nope")).status).toBe(401)
    const authed = await api(hub, "GET", "/nope")
    expect(authed.status).toBe(404)
    expect(authed.body.error.code).toBe("not_found")
  })
})

describe("browser journey", () => {
  test("machines, create, get, live events and cancel over the same origin", async () => {
    hub = startHub()
    const node = await enroll(hub)
    await heartbeat(hub, node)
    const auth = { authorization: `Bearer ${hub.config.adminToken}` }

    // Machines view.
    const nodes = (await (await fetch(`${hub.url}/v1/nodes`, { headers: auth })).json()) as any
    expect(nodes.nodes.map((view: { name: string }) => view.name)).toEqual(["node-1"])

    // Create a run from the form.
    const created = await createRun(hub)
    expect(created.status).toBe(201)
    const runId = created.body.runId as string

    // Get the run.
    const run = (await (await fetch(`${hub.url}/v1/runs/${runId}`, { headers: auth })).json()) as any
    expect(run.status).toBe("queued")

    // The node produces events, then finishes.
    const command = (await nextCommand(hub, node)).body
    const appended = await signedFetch(hub, node, "POST", `/v1/node/commands/${command.commandId}/events`, {
      leaseId: command.leaseId,
      events: [{ key: "c1:1", type: "message.delta", at: new Date().toISOString(), data: { text: "hello" } }],
    })
    expect(appended.status).toBe(200)
    const completed = await signedFetch(hub, node, "POST", `/v1/node/commands/${command.commandId}/complete`, {
      leaseId: command.leaseId,
      status: "succeeded",
      result: { status: "completed", output: "done" },
      eventsToSeq: 1,
    })
    expect(completed.status).toBe(200)

    // Live event stream, read the way the UI reads it: header auth, no token in the URL.
    const stream = await fetch(`${hub.url}/v1/runs/${runId}/events?stream=sse&after=0`, { headers: auth })
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const text = await stream.text()
    expect(text).toContain("message.delta")
    expect(text).toContain("run.finished")
    expect(text).not.toContain(hub.config.adminToken)

    const finished = (await (await fetch(`${hub.url}/v1/runs/${runId}`, { headers: auth })).json()) as any
    expect(finished.status).toBe("completed")
    expect(finished.result).toEqual({ status: "completed", output: "done" })

    // Cancel a second run from the detail view.
    const second = await createRun(hub)
    const cancelled = await fetch(`${hub.url}/v1/runs/${second.body.runId}/cancel`, { method: "POST", headers: auth })
    expect(cancelled.status).toBe(200)
    expect(((await cancelled.json()) as any).status).toBe("cancelled")
  })
})
