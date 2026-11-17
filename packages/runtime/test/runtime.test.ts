import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime, type HarnessDefinition, type RunEvent, type RunInput } from "../src/index.ts"
import { conformance, type ConformanceTarget } from "./conformance.ts"

const fakeAgent = join(import.meta.dir, "fake-agent.ts")
const cwd = tmpdir()

const fake = (scenario: string, caps: object = {}): HarnessDefinition => ({
  id: "fake",
  profile: "coding",
  command: process.execPath,
  args: [fakeAgent],
  env: { FAKE_SCENARIO: scenario, FAKE_CAPS: JSON.stringify(caps) },
})

const run = (scenario: string, input: Partial<RunInput> = {}, caps: object = {}) =>
  createRuntime().run({ harness: fake(scenario, caps), cwd, prompt: "go", ...input })

const collect = async (events: AsyncIterable<RunEvent>) => {
  const seen: RunEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

/** A stopped process can stay a zombie until its new parent reaps it, so state matters, not existence. */
const isAlive = (pid: number) => {
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim()
  return state !== "" && !state.startsWith("Z")
}

const started: number[] = []
afterEach(() => {
  for (const pid of started.splice(0)) if (isAlive(pid)) process.kill(pid, "SIGKILL")
})

describe("conformance: fake agent", () => {
  const target: ConformanceTarget = { harness: fake, cwd, prompt: "go" }
  for (const [name, item] of Object.entries(conformance)) test(name, () => item.run(target))
})

const realHarness = process.env.AGENTICFORM_CONFORMANCE_HARNESS
describe.skipIf(!realHarness)(`conformance: ${realHarness}`, () => {
  const definition = createRuntime()
    .harnesses()
    .find((item) => item.id === realHarness)
  const target: ConformanceTarget = {
    harness: () => definition!,
    cwd: process.env.AGENTICFORM_CONFORMANCE_CWD ?? cwd,
    prompt: "Reply with the single word OK and do nothing else.",
  }
  for (const [name, item] of Object.entries(conformance)) {
    if (!item.scripted) test(name, () => item.run(target), 180_000)
  }
})

describe("runs", () => {
  test("normalises the stream and ignores other sessions", async () => {
    const current = run("ok")
    const types = (await collect(current.events())).map((event) => event.type)
    expect(types).toEqual([
      "run.started",
      "run.capabilities",
      "turn.started",
      "thought.delta",
      "tool.call",
      "tool.update",
      "plan",
      "other",
      "message.delta",
      "message.delta",
      "turn.finished",
      "run.finished",
    ])
    expect((await current.result()).text).toBe("hello world")
  })

  test("late consumers see the whole run", async () => {
    const current = run("ok")
    await current.result()
    const [first, second] = await Promise.all([collect(current.events()), collect(current.events())])
    expect(first).toEqual(second)
    expect(first[0]?.type).toBe("run.started")
  })

  test("uses runtime-issued turn ids", async () => {
    const events = await collect(run("ok").events())
    const turn = events.find((event) => event.type === "turn.started")
    expect(turn?.type === "turn.started" && turn.turnId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("reports incomplete stops", async () => {
    const result = await run("max-tokens").result()
    expect(result.status).toBe("incomplete")
    expect(result.stopReason).toBe("max_tokens")
  })
})

describe("named failures", () => {
  const failures: [string, Partial<RunInput>, string][] = [
    ["ok", { cwd: "relative/path" }, "invalid_input"],
    ["ok", { prompt: "" }, "invalid_input"],
    ["ok", { harness: "missing" }, "unknown_harness"],
    ["ok", { harness: { id: "none", profile: "coding", command: "/no/such/binary" } }, "spawn_failed"],
    ["hang-initialize", { handshakeTimeoutMs: 100 }, "handshake_timeout"],
    ["hang-session", { handshakeTimeoutMs: 300 }, "handshake_timeout"],
    ["wrong-version", {}, "protocol_unsupported"],
    ["auth", {}, "auth_required"],
    ["error", {}, "agent_error"],
    [
      "ok",
      { mcpServers: [{ type: "http", name: "remote", url: "https://example.test", headers: [] }] },
      "capability_missing",
    ],
  ]

  for (const [scenario, input, code] of failures) {
    test(`${scenario} ${Object.keys(input).join()} -> ${code}`, async () => {
      const current = run(scenario, input)
      const events = await collect(current.events())
      const result = await current.result()
      expect(result.status).toBe("failed")
      expect(result.error?.code as string).toBe(code)
      expect(events.at(-1)?.type).toBe("run.finished")
    })
  }

  test("capability requirements pass when negotiated", async () => {
    const result = await run("ok", { requires: ["session.load", "mcp.http"] }, {
      loadSession: true,
      mcpCapabilities: { http: true },
    }).result()
    expect(result.status).toBe("completed")
  })
})

describe("permissions", () => {
  test("a throwing handler denies", async () => {
    const result = await run("permission", {
      onPermission: () => {
        throw new Error("boom")
      },
    }).result()
    expect(result.text).toBe("no")
  })

  test("an unanswered request is denied after the timeout", async () => {
    const result = await run("permission", {
      onPermission: () => new Promise(() => {}),
      permissionTimeoutMs: 50,
    }).result()
    expect(result.text).toBe("no")
  })

  test("allow never selects a persistent grant", async () => {
    const result = await run("permission-always-only", { onPermission: () => "allow" }).result()
    expect(result.text).toBe("no")
  })

  test("decisions appear in events", async () => {
    const events = await collect(run("permission", { onPermission: () => "allow" }).events())
    const resolved = events.find((event) => event.type === "permission.resolved")
    expect(resolved?.type === "permission.resolved" && resolved.decision).toBe("allow")
  })
})

describe("interruption", () => {
  const until = async (current: ReturnType<typeof run>, type: RunEvent["type"]) => {
    for await (const event of current.events()) if (event.type === type) return
  }

  test("steer starts a marked emulated turn", async () => {
    const current = run("cancellable")
    await until(current, "message.delta")
    await current.steer("new direction")
    const result = await current.result()
    const turns = (await collect(current.events())).filter((event) => event.type === "turn.started")
    expect(result.status).toBe("completed")
    expect(result.text).toBe("working on: new direction")
    expect(turns).toHaveLength(2)
    expect(turns[1]?.type === "turn.started" && turns[1].emulated).toBe(true)
  })

  test("an agent that ignores cancel is stopped", async () => {
    const current = run("ignore-cancel", { cancelGraceMs: 50 })
    await until(current, "message.delta")
    await current.cancel()
    expect((await current.result()).status).toBe("cancelled")
  })

  test("an aborted signal starts no process", async () => {
    const controller = new AbortController()
    controller.abort()
    const current = run("ok", { signal: controller.signal })
    const result = await current.result()
    expect(result.status).toBe("cancelled")
    expect(current.capabilities).toBeNull()
  })

  test("a signal cancels a running turn", async () => {
    const controller = new AbortController()
    const current = run("cancellable", { signal: controller.signal })
    await until(current, "message.delta")
    controller.abort()
    expect((await current.result()).status).toBe("cancelled")
  })

  test("children of the agent are stopped with the run", async () => {
    const result = await run("child").result()
    const pid = Number(result.text)
    started.push(pid)
    await Bun.sleep(100)
    expect(isAlive(pid)).toBe(false)
  })
})

describe("catalog", () => {
  test("no entry claims to be tested without proof", () => {
    const entries = createRuntime().harnesses()
    expect(entries.map((item) => item.id).sort()).toEqual(
      ["claude", "codex", "dsh", "hermes", "omp", "opencode", "openclaw", "pi"].sort(),
    )
    expect(entries.every((item) => item.verification === "documented")).toBe(true)
  })
})
