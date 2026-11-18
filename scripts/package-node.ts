#!/usr/bin/env bun
/**
 * FR-020 packaging test (spec 004 T038).
 *
 *   bun scripts/package-node.ts
 *
 * Builds the node two ways — a `bun build --compile` binary and a plain
 * `bun install --production` workspace tree — lists what each contains, fails
 * if anything beyond the node, its workspace dependencies and the runtime is
 * included, and measures size and cold start to the first heartbeat.
 *
 * The heartbeat target is a fake hub: it accepts the signed request without
 * verifying it, so the measurement is the node's own startup, not a database.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { generateKeyPair, saveIdentity } from "../packages/node/src/identity.ts"

const ROOT = join(import.meta.dir, "..")
const WORKSPACE_PACKAGES = ["node", "protocol", "runtime"] as const
const ALLOWED_TOP = new Set(["package.json", "bun.lock", "node_modules", "packages"])

interface Variant {
  name: "compiled" | "install"
  contents: string[]
  sizeBytes: number
  startMs: number
}

const fail = (message: string): never => {
  console.error(`package-node: ${message}`)
  process.exit(1)
}

/** Every file under `dir`, relative and sorted. */
function listFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(relative(dir, path))
    }
  }
  walk(dir)
  return files.sort()
}

const sizeOf = (dir: string): number =>
  listFiles(dir).reduce((total, file) => total + statSync(join(dir, file)).size, 0)

const formatBytes = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`

/** A hub that answers the node's first heartbeat and nothing else. */
function fakeHub(): { url: string; firstHeartbeat: () => number | null; stop: () => void } {
  let first: number | null = null
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/v1/node/heartbeat") {
        first ??= Date.now()
        return Response.json({ status: "online", commandsPollMs: 100 })
      }
      if (path === "/v1/node/commands/next") return new Response(null, { status: 204 })
      return new Response(null, { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    firstHeartbeat: () => first,
    stop: () => server.stop(true),
  }
}

/** Spawn a variant, wait for its first heartbeat, and return the elapsed ms. */
async function coldStart(command: string[], cwd: string, stateDir: string): Promise<number> {
  const hub = fakeHub()
  const keys = generateKeyPair()
  saveIdentity(stateDir, {
    ...keys,
    nodeId: "00000000-0000-4000-8000-000000000000",
    hubUrl: hub.url,
  })
  const started = Date.now()
  const child = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      AGENTICFORM_HUB_URL: hub.url,
      AGENTICFORM_STATE_DIR: stateDir,
      AGENTICFORM_POLL_MS: "100",
      AGENTICFORM_HEARTBEAT_SECONDS: "1",
      AGENTICFORM_HARNESS_PROBE_TIMEOUT_SECONDS: "2",
      AGENTICFORM_NODE_HARNESSES: "opencode",
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  try {
    const until = Date.now() + 30_000
    while (hub.firstHeartbeat() === null) {
      if (child.exitCode !== null) {
        const stderr = await new Response(child.stderr).text()
        fail(`the ${command[0]} node exited before its first heartbeat: ${stderr.trim()}`)
      }
      if (Date.now() > until) fail("the node did not heartbeat within 30 s")
      await Bun.sleep(10)
    }
    return (hub.firstHeartbeat() as number) - started
  } finally {
    child.kill()
    await Promise.race([child.exited, Bun.sleep(5_000)])
    if (child.exitCode === null) child.kill(9)
    hub.stop()
  }
}

async function buildCompiled(work: string): Promise<Variant> {
  const outDir = join(work, "compiled")
  mkdirSync(outDir, { recursive: true })
  const binary = join(outDir, "agenticform-node")
  const build = Bun.spawn(
    ["bun", "build", "--compile", "--outfile", binary, join(ROOT, "packages", "node", "bin", "node.ts")],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  )
  const [stderr, code] = await Promise.all([new Response(build.stderr).text(), build.exited])
  if (code !== 0) fail(`bun build --compile failed: ${stderr.trim()}`)

  const contents = listFiles(outDir)
  if (contents.length !== 1) fail(`the compiled build has extra contents: ${contents.join(", ")}`)
  const startMs = await coldStart([binary, "run"], outDir, join(work, "compiled-state"))
  return { name: "compiled", contents, sizeBytes: sizeOf(outDir), startMs }
}

async function buildInstall(work: string): Promise<Variant> {
  const tree = join(work, "install")
  mkdirSync(join(tree, "packages"), { recursive: true })
  writeFileSync(
    join(tree, "package.json"),
    `${JSON.stringify(
      {
        name: "agenticform-node-install",
        private: true,
        type: "module",
        workspaces: ["packages/*"],
      },
      null,
      2,
    )}\n`,
  )
  for (const name of WORKSPACE_PACKAGES) {
    cpSync(join(ROOT, "packages", name), join(tree, "packages", name), { recursive: true })
  }
  const install = Bun.spawn(["bun", "install", "--production"], {
    cwd: tree,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, code] = await Promise.all([new Response(install.stderr).text(), install.exited])
  if (code !== 0) fail(`bun install --production failed: ${stderr.trim()}`)

  const top = readdirSync(tree)
  const extraTop = top.filter((entry) => !ALLOWED_TOP.has(entry))
  if (extraTop.length > 0) fail(`the install tree has extra top-level entries: ${extraTop.join(", ")}`)
  const packages = readdirSync(join(tree, "packages"))
  const extraPackages = packages.filter((entry) => !(WORKSPACE_PACKAGES as readonly string[]).includes(entry))
  if (extraPackages.length > 0) fail(`the install tree has extra packages: ${extraPackages.join(", ")}`)

  const startMs = await coldStart(
    ["bun", join(tree, "packages", "node", "bin", "node.ts"), "run"],
    tree,
    join(work, "install-state"),
  )
  return {
    name: "install",
    contents: [...top, ...packages.map((entry) => `packages/${entry}`)],
    sizeBytes: sizeOf(tree),
    startMs,
  }
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "af-package-"))
  try {
    const variants = [await buildCompiled(work), await buildInstall(work)]
    const rows = variants.map((variant) => ({
      variant: variant.name,
      contents: variant.contents.length === 1 ? variant.contents[0] : `${variant.contents.length} entries`,
      size: formatBytes(variant.sizeBytes),
      "cold start": `${variant.startMs} ms`,
    }))
    console.table(rows)
    for (const variant of variants) {
      console.log(`${variant.name}: ${variant.contents.join(", ")}`)
    }
    const [compiled, install] = variants as [Variant, Variant]
    const smaller = compiled.sizeBytes <= install.sizeBytes ? "compiled" : "install"
    const faster = compiled.startMs <= install.startMs ? "compiled" : "install"
    console.log(`recommended: ${smaller === faster ? smaller : `${smaller} for size, ${faster} for start`}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`package-node: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
