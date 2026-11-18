import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { CommandEnvelope, HarnessStatus, HeartbeatRequest } from "@agenticform/protocol"
import {
  createRuntime,
  RuntimeError,
  type Capabilities,
  type DriverConnection,
  type HarnessDefinition,
  type RuntimeDriver,
} from "@agenticform/runtime"
import { Executor } from "../src/executor.ts"
import { HarnessProber, probeHarness, resolveHarness } from "../src/harness-probe.ts"
import { startHeartbeat } from "../src/heartbeat.ts"
import { fingerprintOf } from "../src/state.ts"

const hasBwrap = Bun.spawnSync(["sh", "-c", "command -v bwrap"]).exitCode === 0
const tempRoot = Bun.spawnSync(["sh", "-c", "test -w /var/tmp"]).exitCode === 0 ? "/var/tmp" : tmpdir()
const tempDirs: string[] = []
const temp = (prefix: string, root = tempRoot): string => {
  const dir = mkdtempSync(join(root, prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fakeSource = readFileSync(join(import.meta.dir, "fake-harness.ts"), "utf8")
/** A real executable ACP child in a non-standard directory. */
const fakeEntry = (dir: string, name = "fake-harness.ts"): string => {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bun\n${fakeSource}`, { mode: 0o755 })
  return path
}
const definition = (entry: string, spec: object = {}, id = "fake"): HarnessDefinition => ({
  id,
  profile: "coding",
  command: entry,
  args: [JSON.stringify(spec)],
})

const supported: Capabilities["supported"] = {
  cancel: true,
  "steer.emulated": false,
  "mcp.stdio": false,
  "mcp.http": false,
  "mcp.sse": false,
  "session.load": false,
  "session.resume": false,
  "prompt.image": false,
  "prompt.embeddedContext": false,
}

const fakeDriver = (onConnect: () => void, fail = false): RuntimeDriver => ({
  async connect(): Promise<DriverConnection> {
    onConnect()
    return {
      capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
      async openSession() {},
      async prompt() {
        if (fail) throw new Error("boom")
        return { stopReason: "end_turn" }
      },
      async cancel() {},
      async close() {},
      stderrTail() {
        return ""
      },
    }
  },
})

const command = (harness: string, cwd: string): CommandEnvelope => {
  const payload = {
    fingerprint: "",
    generation: 1,
    harness,
    cwd,
    prompt: "go",
    requires: [],
    mcpServers: [],
  }
  const envelope: CommandEnvelope = {
    commandId: `cmd-${harness}`,
    type: "run.start",
    runId: `run-${harness}`,
    generation: 1,
    idempotencyKey: `run:${harness}:run.start:1`,
    leasedUntil: new Date(Date.now() + 60_000).toISOString(),
    leaseId: "lease-1",
    payload,
  }
  return { ...envelope, payload: { ...payload, fingerprint: fingerprintOf(envelope) } }
}

describe("entry-point resolution", () => {
  test("a direct command resolves on PATH and binds its directory", () => {
    const dir = temp("af-entry-")
    const entry = join(dir, "agent")
    writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 })
    const resolution = resolveHarness({ id: "fake", profile: "coding", command: "agent" }, { path: dir })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) return
    expect(resolution.resolved.definition.command).toBe(entry)
    expect(resolution.resolved.dirs).toContain(dir)
  })

  test("a missing command is missing/not_installed", () => {
    expect(resolveHarness({ id: "fake", profile: "coding", command: "absent" }, { path: temp("af-empty-") })).toEqual({
      ok: false,
      status: "missing",
      reason: "not_installed",
    })
  })

  test("a script's interpreter directory is bound too", () => {
    const dir = temp("af-entry-")
    const entry = join(dir, "agent")
    writeFileSync(entry, "#!/usr/bin/env bun\n", { mode: 0o755 })
    const resolution = resolveHarness(
      { id: "fake", profile: "coding", command: entry },
      { path: dirname(process.execPath) },
    )
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) return
    expect(resolution.resolved.dirs).toContain(dir)
    expect(resolution.resolved.dirs).toContain(dirname(process.execPath))
  })

  test("a bunx entry resolves from the local cache without network", () => {
    const cache = temp("af-cache-")
    const root = join(cache, ".bunx-1000", "@scope", "pkg@1.0.0")
    const pkg = join(root, "node_modules", "@scope", "pkg")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@scope/pkg", bin: { pkg: "index.js" } }))
    writeFileSync(join(pkg, "index.js"), "")
    const resolution = resolveHarness(
      { id: "fake", profile: "coding", command: "bunx", args: ["@scope/pkg@1.0.0"] },
      { cacheRoot: cache, path: dirname(process.execPath) },
    )
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) return
    expect(resolution.resolved.definition.command).toBe(process.execPath)
    expect(resolution.resolved.definition.args?.[0]).toBe(join(pkg, "index.js"))
    expect(resolution.resolved.dirs).toContain(join(root, "node_modules"))
  })

  test("a pinned version absent from the cache is missing/version_not_cached and downloads nothing", () => {
    const cache = temp("af-cache-")
    const resolution = resolveHarness(
      { id: "fake", profile: "coding", command: "bunx", args: ["@scope/pkg@9.9.9"] },
      { cacheRoot: cache, path: dirname(process.execPath) },
    )
    expect(resolution).toEqual({ ok: false, status: "missing", reason: "version_not_cached" })
    expect(Bun.spawnSync(["sh", "-c", `find ${cache} -mindepth 1 | wc -l`]).stdout.toString().trim()).toBe("0")
  })
})

describe.skipIf(!hasBwrap)("probe: real bwrap", () => {
  for (const root of ["/tmp", "/var/tmp"]) {
    test(`a fake harness under ${root} is reachable inside the sandbox`, async () => {
      const entry = fakeEntry(temp("af-entry-", root))
      const report = await probeHarness(definition(entry), { timeoutMs: 20_000 })
      expect(report).toEqual({ id: "fake", status: "ready" })
    }, 30_000)
  }

  test("a harness that answers auth_required is unauthenticated", async () => {
    const entry = fakeEntry(temp("af-entry-"))
    const report = await probeHarness(definition(entry, { scenario: "auth" }), { timeoutMs: 20_000 })
    expect(report).toEqual({ id: "fake", status: "unauthenticated", reason: "auth_required" })
  }, 30_000)

  test("an absent entry point is missing/not_installed", async () => {
    const report = await probeHarness(
      { id: "fake", profile: "coding", command: join(temp("af-entry-"), "absent") },
      { timeoutMs: 5_000 },
    )
    expect(report).toEqual({ id: "fake", status: "missing", reason: "not_installed" })
  })

  test("a hung harness times out as unknown and the heartbeat keeps beating", async () => {
    const dir = temp("af-entry-")
    const slow = join(dir, "slow")
    writeFileSync(slow, "#!/bin/sh\nsleep 300\n", { mode: 0o755 })
    const prober = new HarnessProber({
      definitions: () => [{ id: "slow", profile: "coding", command: slow }],
      ttlMs: 60_000,
      readyTtlMs: 60_000,
      timeoutMs: 500,
    })
    await prober.refresh()
    expect(prober.report()).toEqual([{ id: "slow", status: "unknown", reason: "handshake_timeout" }])

    const bodies: HeartbeatRequest[] = []
    const loop = startHeartbeat(
      {
        heartbeat: async (body: HeartbeatRequest) => {
          bodies.push(body)
          return { status: "online", commandsPollMs: 1_500 }
        },
      } as never,
      {
        intervalMs: 60_000,
        body: () => ({ protocolVersion: 1, harnesses: [], harnessReport: prober.report() }),
      },
    )
    await loop.tick()
    expect(bodies.at(-1)?.harnessReport).toEqual([{ id: "slow", status: "unknown", reason: "handshake_timeout" }])
    await loop.stop()
  }, 30_000)

  test("one ready, one auth_required and one absent harness report three statuses", async () => {
    const ready = definition(fakeEntry(temp("af-entry-")), {}, "ready")
    const auth = definition(fakeEntry(temp("af-entry-")), { scenario: "auth" }, "auth")
    const absent: HarnessDefinition = { id: "absent", profile: "coding", command: join(temp("af-entry-"), "absent") }
    const prober = new HarnessProber({
      definitions: () => [ready, auth, absent],
      ttlMs: 60_000,
      readyTtlMs: 60_000,
      timeoutMs: 20_000,
    })
    await prober.refresh()
    expect(prober.report()).toEqual([
      { id: "ready", status: "ready" },
      { id: "auth", status: "unauthenticated", reason: "auth_required" },
      { id: "absent", status: "missing", reason: "not_installed" },
    ])
  }, 60_000)
})

describe("probe classification", () => {
  const resolved = (definition: HarnessDefinition) => () => ({
    ok: true as const,
    resolved: { definition, dirs: [], files: [] },
  })

  test("a spawn failure is missing/spawn_failed", async () => {
    const report = await probeHarness(definition("/nonexistent"), {
      timeoutMs: 1_000,
      resolve: resolved(definition("/nonexistent")),
      driver: {
        async connect() {
          throw new RuntimeError("spawn_failed", "no")
        },
      },
    })
    expect(report).toEqual({ id: "fake", status: "missing", reason: "spawn_failed" })
  })

  test("a process exit before the handshake is unknown/process_exited", async () => {
    const report = await probeHarness(definition("/nonexistent"), {
      timeoutMs: 1_000,
      resolve: resolved(definition("/nonexistent")),
      driver: {
        async connect() {
          throw new RuntimeError("process_exited", "gone")
        },
      },
    })
    expect(report).toEqual({ id: "fake", status: "unknown", reason: "process_exited" })
  })
})

describe("probe cache", () => {
  const def: HarnessDefinition = { id: "fake", profile: "coding", command: "fake" }

  test("a result is cached for the TTL and re-probed after it", async () => {
    let now = 0
    let calls = 0
    const prober = new HarnessProber({
      definitions: () => [def],
      ttlMs: 1_000,
      readyTtlMs: 1_000,
      timeoutMs: 1_000,
      now: () => now,
      probe: async () => {
        calls += 1
        return { id: "fake", status: "ready" }
      },
    })
    await prober.refresh()
    await prober.refresh()
    expect(calls).toBe(1)
    now = 1_001
    await prober.refresh()
    expect(calls).toBe(2)
  })

  test("a ready result is cached longer than a non-ready one", async () => {
    let now = 0
    let calls = 0
    let status: "ready" | "unauthenticated" = "unauthenticated"
    const prober = new HarnessProber({
      definitions: () => [def],
      ttlMs: 1_000,
      readyTtlMs: 10_000,
      timeoutMs: 1_000,
      now: () => now,
      probe: async () => {
        calls += 1
        return status === "ready"
          ? { id: "fake", status: "ready" }
          : { id: "fake", status: "unauthenticated", reason: "auth_required" }
      },
    })
    await prober.refresh()
    expect(calls).toBe(1)
    now = 1_001
    await prober.refresh()
    expect(calls).toBe(2)
    status = "ready"
    now = 2_002
    await prober.refresh()
    expect(calls).toBe(3)
    now = 5_000
    await prober.refresh()
    expect(calls).toBe(3)
    now = 12_003
    await prober.refresh()
    expect(calls).toBe(4)
  })

  test("concurrent refreshes share one probe", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const prober = new HarnessProber({
      definitions: () => [def],
      ttlMs: 1_000,
      readyTtlMs: 1_000,
      timeoutMs: 1_000,
      probe: async () => {
        calls += 1
        await new Promise<void>((resolve) => (release = resolve))
        return { id: "fake", status: "ready" }
      },
    })
    const first = prober.refresh()
    const second = prober.refresh()
    release?.()
    await Promise.all([first, second])
    expect(calls).toBe(1)
  })

  test("a failed run invalidates the entry so the next beat re-probes", async () => {
    let calls = 0
    const prober = new HarnessProber({
      definitions: () => [def],
      ttlMs: 60_000,
      readyTtlMs: 60_000,
      timeoutMs: 1_000,
      probe: async () => {
        calls += 1
        return { id: "fake", status: "ready" }
      },
    })
    await prober.refresh()
    prober.invalidate("fake")
    await prober.refresh()
    expect(calls).toBe(2)
  })

  test("invalidate drops the cached entry point too", async () => {
    const prober = new HarnessProber({
      definitions: () => [{ id: "fake", profile: "coding", command: process.execPath }],
      ttlMs: 60_000,
      readyTtlMs: 60_000,
      timeoutMs: 1_000,
      probe: async () => ({ id: "fake", status: "ready" }),
    })
    await prober.refresh()
    expect(prober.resolved("fake")).toBeDefined()
    prober.invalidate("fake")
    expect(prober.resolved("fake")).toBeUndefined()
  })

  test("a login is picked up after the TTL without a restart", async () => {
    let now = 0
    let loggedIn = false
    const prober = new HarnessProber({
      definitions: () => [def],
      ttlMs: 1_000,
      readyTtlMs: 1_000,
      timeoutMs: 1_000,
      now: () => now,
      probe: async () =>
        loggedIn ? { id: "fake", status: "ready" } : { id: "fake", status: "unauthenticated", reason: "auth_required" },
    })
    await prober.refresh()
    expect(prober.status("fake")).toBe("unauthenticated")
    loggedIn = true
    await prober.refresh()
    expect(prober.status("fake")).toBe("unauthenticated")
    now = 1_001
    await prober.refresh()
    expect(prober.status("fake")).toBe("ready")
  })

  test("the report includes every configured harness, probed or not", async () => {
    const prober = new HarnessProber({
      definitions: () => [def, { id: "other", profile: "coding", command: "other" }],
      ttlMs: 60_000,
      readyTtlMs: 60_000,
      timeoutMs: 1_000,
      probe: async (definition) => ({ id: definition.id, status: "ready" }),
    })
    await prober.refresh()
    expect(prober.report()).toEqual([
      { id: "fake", status: "ready" },
      { id: "other", status: "ready" },
    ])
  })
})

describe("non-ready runs", () => {
  test("each non-ready harness fails with its named code and spawns no child", async () => {
    let connected = 0
    const statuses: Record<string, "ready" | "missing" | "unauthenticated" | "unknown"> = {
      ready: "ready",
      auth: "unauthenticated",
      absent: "missing",
      unknown: "unknown",
    }
    const runtime = createRuntime({
      driver: fakeDriver(() => (connected += 1)),
      harnesses: {
        ready: { id: "ready", profile: "coding", command: process.execPath },
        auth: { id: "auth", profile: "coding", command: process.execPath },
        absent: { id: "absent", profile: "coding", command: process.execPath },
        unknown: { id: "unknown", profile: "coding", command: process.execPath },
      },
    })
    const executor = new Executor({ runtime, harnessStatus: (id) => statuses[id] })
    const cwd = temp("af-ws-")
    const run = async (harness: string) =>
      executor.execute(command(harness, cwd), { emit: () => {}, signal: new AbortController().signal })

    expect((await run("ready")).status).toBe("succeeded")
    expect(await run("auth")).toEqual({
      status: "failed",
      error: { code: "harness_unauthenticated", message: "Harness needs authentication: auth" },
    })
    expect(await run("absent")).toEqual({
      status: "failed",
      error: { code: "harness_missing", message: "Harness is missing: absent" },
    })
    expect(await run("unknown")).toEqual({
      status: "failed",
      error: { code: "harness_unavailable", message: "Harness is unavailable: unknown" },
    })
    expect(connected).toBe(1)
  })

  test("a failed run invalidates the harness probe entry", async () => {
    const invalidated: string[] = []
    const runtime = createRuntime({
      driver: fakeDriver(() => {}, true),
      harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } },
    })
    const executor = new Executor({
      runtime,
      harnessStatus: () => "ready",
      harnessFailed: (id) => invalidated.push(id),
    })
    const outcome = await executor.execute(command("fake", temp("af-ws-")), {
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe("failed")
    expect(invalidated).toEqual(["fake"])
  })

  test("an unsafe entry dir binds only the file, never a root bind", async () => {
    let captured: HarnessDefinition | undefined
    const driver: RuntimeDriver = {
      async connect(input): Promise<DriverConnection> {
        captured = input.harness
        return {
          capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
          async openSession() {},
          async prompt() {
            return { stopReason: "end_turn" }
          },
          async cancel() {},
          async close() {},
          stderrTail() {
            return ""
          },
        }
      },
    }
    const executor = new Executor({
      runtime: createRuntime({
        driver,
        harnesses: { fake: { id: "fake", profile: "coding", command: "/agent" } },
      }),
      harnessStatus: () => "ready",
      harnessEntry: () => ({ definition: { id: "fake", profile: "coding", command: "/agent" }, dirs: ["/"], files: [] }),
    })
    const outcome = await executor.execute(command("fake", temp("af-ws-")), {
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe("succeeded")
    const args = captured?.args ?? []
    const rootBinds = args.flatMap((arg, index) => (arg === "--ro-bind" && args[index + 1] === "/" ? ["/"] : []))
    expect(rootBinds).toEqual([])
  })

  test("a run before the first probe triggers a probe and waits", async () => {
    let status: HarnessStatus | undefined
    let probes = 0
    let connected = 0
    const executor = new Executor({
      runtime: createRuntime({
        driver: fakeDriver(() => (connected += 1)),
        harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } },
      }),
      harnessStatus: () => status,
      harnessProbe: async () => {
        probes += 1
        status = "ready"
        return status
      },
    })
    const outcome = await executor.execute(command("fake", temp("af-ws-")), {
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe("succeeded")
    expect(probes).toBe(1)
    expect(connected).toBe(1)
  })

  test("a run for a healthy harness does not wait for a hung sibling", async () => {
    let healthyProbes = 0
    let hungProbes = 0
    const prober = new HarnessProber({
      definitions: () => [
        { id: "hung", profile: "coding", command: "hung" },
        { id: "healthy", profile: "coding", command: "healthy" },
      ],
      ttlMs: 60_000,
      readyTtlMs: 60_000,
      timeoutMs: 60_000,
      probe: async (definition) => {
        if (definition.id === "hung") {
          hungProbes += 1
          await new Promise(() => {})
        }
        healthyProbes += 1
        return { id: definition.id, status: "ready" }
      },
    })
    // A refresh starts with the hung harness and never finishes.
    void prober.refresh()
    await Bun.sleep(10)
    const executor = new Executor({
      runtime: createRuntime({
        driver: fakeDriver(() => {}),
        harnesses: { healthy: { id: "healthy", profile: "coding", command: process.execPath } },
      }),
      harnessStatus: (id) => prober.status(id),
      harnessProbe: (id) => prober.ensure(id),
      probeWaitMs: 2_000,
    })
    const outcome = await executor.execute(command("healthy", temp("af-ws-")), {
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe("succeeded")
    expect(healthyProbes).toBe(1)
    expect(hungProbes).toBe(1)
  })

  test("a probe that does not finish within the bound fails clearly", async () => {
    const executor = new Executor({
      runtime: createRuntime({
        driver: fakeDriver(() => {}),
        harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } },
      }),
      harnessStatus: () => undefined,
      harnessProbe: () => new Promise(() => {}),
      probeWaitMs: 10,
    })
    const outcome = await executor.execute(command("fake", temp("af-ws-")), {
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(outcome.error?.code).toBe("harness_unavailable")
    expect(outcome.error?.message).toContain("probe did not finish")
  })

  test("an unconfigured harness is harness_missing", async () => {
    let connected = 0
    const executor = new Executor({
      runtime: createRuntime({
        driver: fakeDriver(() => (connected += 1)),
        harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } },
      }),
      harnesses: ["other"],
      harnessStatus: () => "ready",
    })
    const outcome = await executor.execute(command("fake", temp("af-ws-")), {
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(outcome.error?.code).toBe("harness_missing")
    expect(connected).toBe(0)
  })

  test("a run reuses the prober's resolved entry dirs", async () => {
    const dir = temp("af-entry-")
    let captured: HarnessDefinition | undefined
    const driver: RuntimeDriver = {
      async connect(input): Promise<DriverConnection> {
        captured = input.harness
        return {
          capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
          async openSession() {},
          async prompt() {
            return { stopReason: "end_turn" }
          },
          async cancel() {},
          async close() {},
          stderrTail() {
            return ""
          },
        }
      },
    }
    const executor = new Executor({
      runtime: createRuntime({
        driver,
        harnesses: { fake: { id: "fake", profile: "coding", command: "/unresolvable" } },
      }),
      harnessStatus: () => "ready",
      harnessEntry: () => ({ definition: { id: "fake", profile: "coding", command: "/unresolvable" }, dirs: [dir], files: [] }),
    })
    const outcome = await executor.execute(command("fake", temp("af-ws-")), {
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe("succeeded")
    expect(captured?.args).toContain(dir)
  })
})

describe("heartbeat", () => {
  test("a forced tick joins an in-flight beat", async () => {
    let calls = 0
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    let release: (() => void) | undefined
    const loop = startHeartbeat(
      {
        heartbeat: async () => {
          calls += 1
          markStarted?.()
          await new Promise<void>((resolve) => (release = resolve))
          return { status: "online", commandsPollMs: 1_500 }
        },
      } as never,
      { intervalMs: 60_000, body: () => ({ protocolVersion: 1, harnesses: [] }) },
    )
    await started
    const forced = loop.tick()
    release?.()
    await forced
    expect(calls).toBe(1)
    await loop.stop()
  })
})

describe.skipIf(!hasBwrap)("real harnesses", () => {
  const catalog = createRuntime().harnesses()
  const claude = catalog.find((harness) => harness.id === "claude")
  const opencode = catalog.find((harness) => harness.id === "opencode")
  const claudeReady = claude !== undefined && resolveHarness(claude).ok
  const opencodeReady = opencode !== undefined && resolveHarness(opencode).ok

  test.skipIf(!claudeReady)("claude: one short sandboxed handshake is ready", async () => {
    const report = await probeHarness(claude as HarnessDefinition, { timeoutMs: 30_000 })
    expect(report).toEqual({ id: "claude", status: "ready" })
  }, 60_000)

  test.skipIf(!opencodeReady)("opencode: one short sandboxed handshake is ready", async () => {
    const report = await probeHarness(opencode as HarnessDefinition, { timeoutMs: 30_000 })
    expect(report).toEqual({ id: "opencode", status: "ready" })
  }, 60_000)
})
