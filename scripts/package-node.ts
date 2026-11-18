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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { generateKeyPair, saveIdentity } from "../packages/node/src/identity.ts"

const ROOT = join(import.meta.dir, "..")
const WORKSPACE_PACKAGES = ["node", "protocol", "runtime"] as const
/**
 * The only node_modules entries the node may ship: bun's store and its deps.
 * `zod` is installed as the SDK's peer dependency. `bun install --production`
 * does not create `node_modules/.bin` on Linux (bun 1.4.4), so it is not allowed.
 */
const ALLOWED_NODE_MODULES = new Set([".bun", "zod"])
const ALLOWED_SCOPES = new Set(["@agenticform", "@agentclientprotocol"])
interface Variant {
  name: "compiled" | "install"
  contents: string[]
  sizeBytes: number
  startMs: number
}

const fail = (message: string): never => {
  throw new Error(message)
}

/** Every entry under `dir`, relative and sorted. Symlinks are not followed. */
function walkEntries(dir: string, base = dir): { path: string; isDirectory: boolean }[] {
  const entries: { path: string; isDirectory: boolean }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    entries.push({ path: relative(base, path).split(sep).join("/"), isDirectory: entry.isDirectory() })
    if (entry.isDirectory()) entries.push(...walkEntries(path, base))
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

const sizeOf = (dir: string): number =>
  walkEntries(dir).reduce((total, entry) => {
    if (entry.isDirectory) return total
    try {
      return total + statSync(join(dir, entry.path)).size
    } catch {
      return total
    }
  }, 0)

const formatBytes = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`

const allowedNodeModules = (name: string): boolean =>
  ALLOWED_NODE_MODULES.has(name) || ALLOWED_SCOPES.has(name.split("/")[0] ?? "")

/**
 * The install tree may hold only the node, its workspace deps and their deps.
 * Directories are allowed when something allowed lives under them, and the
 * package trees are complete, so a stray test file fails the check.
 */
function allowedPath(path: string, isDirectory: boolean): boolean {
  const parts = path.split("/")
  if (path === "package.json") return !isDirectory
  if (path === "packages" || path === "node_modules") return isDirectory
  if (parts[0] === "packages") {
    const name = parts[1]
    if (name === undefined || !(WORKSPACE_PACKAGES as readonly string[]).includes(name)) return false
    if (parts.length === 2) return isDirectory
    if (parts[2] === "package.json") return parts.length === 3 && !isDirectory
    if (parts[2] === "src" || parts[2] === "bin") return true
    if (parts[2] === "node_modules") {
      const rest = parts.slice(3)
      if (rest.length === 0) return isDirectory
      const pkg = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]
      return pkg !== undefined && allowedNodeModules(pkg)
    }
    return false
  }
  if (parts[0] === "node_modules") {
    const rest = parts.slice(1)
    if (rest.length === 0) return true
    const pkg = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]
    return pkg !== undefined && allowedNodeModules(pkg)
  }
  return false
}

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

  const contents = walkEntries(outDir).map((entry) => entry.path)
  if (contents.length !== 1 || contents[0] !== "agenticform-node") {
    fail(`the compiled build has extra contents: ${contents.join(", ")}`)
  }
  const startMs = await coldStart([binary, "run"], outDir, join(work, "compiled-state"))
  return { name: "compiled", contents, sizeBytes: sizeOf(outDir), startMs }
}

/** Copy only what the node needs to run: package.json, src and bin. */
function copyPackage(name: string, dest: string): void {
  const source = join(ROOT, "packages", name)
  mkdirSync(dest, { recursive: true })
  cpSync(join(source, "package.json"), join(dest, "package.json"))
  for (const dir of ["src", "bin"]) {
    const from = join(source, dir)
    if (existsSync(from)) cpSync(from, join(dest, dir), { recursive: true })
  }
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
  for (const name of WORKSPACE_PACKAGES) copyPackage(name, join(tree, "packages", name))
  const install = Bun.spawn(["bun", "install", "--production"], {
    cwd: tree,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, code] = await Promise.all([new Response(install.stderr).text(), install.exited])
  if (code !== 0) fail(`bun install --production failed: ${stderr.trim()}`)

  const entries = walkEntries(tree)
  const extra = entries
    .filter((entry) => !allowedPath(entry.path, entry.isDirectory))
    .map((entry) => entry.path)
  if (extra.length > 0) {
    const shown = extra.slice(0, 10).join(", ")
    fail(`the install tree has extra contents: ${shown}${extra.length > 10 ? ` (+${extra.length - 10})` : ""}`)
  }

  const startMs = await coldStart(
    ["bun", join(tree, "packages", "node", "bin", "node.ts"), "run"],
    tree,
    join(work, "install-state"),
  )
  return {
    name: "install",
    contents: entries.filter((entry) => !entry.path.includes("/")).map((entry) => entry.path),
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
