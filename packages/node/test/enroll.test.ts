import { afterEach, describe, expect, test } from "bun:test"
import { createPublicKey } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

interface Recorded {
  method: string
  path: string
  body: Record<string, unknown>
}

const root = resolve(import.meta.dir, "../../..")
const script = join(root, "packages/node/bin/node.ts")

// Flags any attempt to bind a listening socket, so "outbound only" is observed, not assumed.
const preload = `
import { writeFileSync } from "node:fs"
import { Server } from "node:net"

const marker = process.env.AF_LISTEN_MARKER
const flag = () => { if (marker) writeFileSync(marker, "listened") }
const original = Server.prototype.listen
Server.prototype.listen = function (...args) {
  flag()
  return original.apply(this, args)
}
const bun = globalThis.Bun
const serve = bun && bun.serve
if (bun && serve) {
  bun.serve = (...args) => {
    flag()
    return serve(...args)
  }
}
`

let stop: (() => void) | undefined
const cleanups: string[] = []

afterEach(() => {
  stop?.()
  stop = undefined
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const readTree = (dir: string): string =>
  readdirSync(dir, { recursive: true })
    .filter((entry) => statSync(join(dir, String(entry))).isFile())
    .map((entry) => readFileSync(join(dir, String(entry)), "utf8"))
    .join("\n")

describe("enrollment", () => {
  test("enrolls by outbound call only and never opens a listening socket", async () => {
    const requests: Recorded[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>
        requests.push({ method: request.method, path: new URL(request.url).pathname, body })
        return Response.json(
          { nodeId: "3f1c2a9e-0000-4000-8000-000000000001", protocolVersion: 1, heartbeatSeconds: 15 },
          { status: 201 },
        )
      },
    })
    stop = () => server.stop(true)

    const work = mkdtempSync(join(tmpdir(), "af-node-enroll-"))
    cleanups.push(work)
    const stateDir = join(work, "state")
    const marker = join(work, "listened")
    const preloadPath = join(work, "preload.ts")
    writeFileSync(preloadPath, preload)

    const child = Bun.spawn(["bun", "--preload", preloadPath, script, "enroll"], {
      cwd: root,
      env: {
        ...process.env,
        AGENTICFORM_HUB_URL: `http://127.0.0.1:${server.port}`,
        AGENTICFORM_STATE_DIR: stateDir,
        AGENTICFORM_ENROLL_TOKEN: "af_enroll_one_time_secret",
        AGENTICFORM_NODE_NAME: "builder-1",
        AGENTICFORM_NODE_HARNESSES: "codex,git",
        AF_LISTEN_MARKER: marker,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await child.exited
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)

    // One outbound request, public key only, token spent in flight.
    expect(requests.length).toBe(1)
    const [request] = requests
    expect(request?.method).toBe("POST")
    expect(request?.path).toBe("/v1/enroll")
    expect(request?.body.token).toBe("af_enroll_one_time_secret")
    expect(request?.body.harnesses).toEqual(["codex", "git"])
    const publicKey = createPublicKey({
      key: Buffer.from(String(request?.body.publicKey), "base64"),
      format: "der",
      type: "spki",
    })
    expect(publicKey.asymmetricKeyType).toBe("ed25519")

    // Identity persisted with the private key at mode 0600.
    const keyFile = join(stateDir, "identity", "device.pem")
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const meta = JSON.parse(readFileSync(join(stateDir, "identity", "node.json"), "utf8")) as {
      nodeId: string
    }
    expect(meta.nodeId).toBe("3f1c2a9e-0000-4000-8000-000000000001")

    // The enrollment token is discarded, and nothing listened.
    expect(readTree(stateDir)).not.toContain("af_enroll_one_time_secret")
    expect(existsSync(marker)).toBe(false)
  })

  test("an over-limit harness list exits 1 before any network call", async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1
        return Response.json({ nodeId: "n", protocolVersion: 1, heartbeatSeconds: 15 }, { status: 201 })
      },
    })
    stop = () => server.stop(true)

    const work = mkdtempSync(join(tmpdir(), "af-node-enroll-"))
    cleanups.push(work)
    const child = Bun.spawn(["bun", script, "enroll"], {
      cwd: root,
      env: {
        ...process.env,
        AGENTICFORM_HUB_URL: `http://127.0.0.1:${server.port}`,
        AGENTICFORM_STATE_DIR: join(work, "state"),
        AGENTICFORM_ENROLL_TOKEN: "af_enroll_one_time_secret",
        AGENTICFORM_NODE_NAME: "builder-1",
        AGENTICFORM_NODE_HARNESSES: Array.from({ length: 33 }, (_, i) => `h${i}`).join(","),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await child.exited
    const stderr = await new Response(child.stderr).text()
    expect(exitCode).toBe(1)
    expect(stderr).toContain("AGENTICFORM_NODE_HARNESSES")
    expect(stderr).toContain("32")
    expect(requests).toBe(0)
  })
})
