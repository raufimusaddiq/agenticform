import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandEnvelope } from "@agenticform/protocol"
import {
  createRuntime,
  type Capabilities,
  type DriverConnection,
  type RuntimeDriver,
} from "@agenticform/runtime"
import { Executor } from "../src/executor.ts"
import { CommandLedger } from "../src/ledger.ts"
import { fingerprintOf } from "../src/state.ts"

const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "af-ledger-test-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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

const countingDriver = (): { driver: RuntimeDriver; connected: () => number } => {
  let count = 0
  return {
    connected: () => count,
    driver: {
      async connect(): Promise<DriverConnection> {
        count += 1
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
    },
  }
}

const runtime = (driver: RuntimeDriver) =>
  createRuntime({ driver, harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } } })

const command = (overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => {
  const payload = {
    fingerprint: "",
    generation: 1,
    harness: "fake",
    cwd: "/tmp",
    prompt: "go",
    ...overrides.payload,
  }
  const envelope: CommandEnvelope = {
    commandId: "cmd-1",
    type: "run.start",
    runId: "run-1",
    generation: 1,
    idempotencyKey: "run:run-1:run.start:1",
    leasedUntil: new Date().toISOString(),
    leaseId: "lease-1",
    ...overrides,
    payload,
  }
  return { ...envelope, payload: { ...payload, fingerprint: fingerprintOf(envelope) } }
}

const context = () => ({ emit: () => {}, signal: new AbortController().signal })

/** Child process for the kill-after-STARTED case: admit, report, then wait to be killed. */
const startedThenWaitCode = [
  `import { CommandLedger } from ${JSON.stringify(join(import.meta.dir, "../src/ledger.ts"))}`,
  `const ledger = new CommandLedger({ dir: process.env.LEDGER_DIR })`,
  `ledger.admit(JSON.parse(process.env.CMD_JSON))`,
  `process.stdout.write("started\\n")`,
  `await new Promise(() => {})`,
].join("\n")

describe("command ledger", () => {
  test("persists started atomically with mode 0600 before the effect", () => {
    const dir = stateDir()
    const ledger = new CommandLedger({ dir })
    expect(ledger.admit(command())).toEqual({ kind: "new" })

    const file = join(dir, "cmd-1.json")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      commandId: "cmd-1",
      fingerprint: fingerprintOf(command()),
      status: "started",
    })
  })

  test("refuses a reused command id with a different fingerprint", () => {
    const ledger = new CommandLedger()
    const failure = { status: "failed" as const, error: { code: "agent_error", message: "boom" } }
    expect(ledger.admit(command())).toEqual({ kind: "new" })
    expect(ledger.admit(command()).kind).toBe("ambiguous")
    ledger.settle(command(), failure)
    expect(ledger.admit(command())).toEqual({ kind: "replay", outcome: failure })
    expect(ledger.admit(command({ payload: { ...command().payload, prompt: "other" } }))).toEqual({
      kind: "conflict",
    })
  })

  test("a corrupt entry is ambiguous, not absent", () => {
    const dir = stateDir()
    const ledger = new CommandLedger({ dir })
    ledger.admit(command())
    writeFileSync(join(dir, "cmd-1.json"), "{not json")
    expect(new CommandLedger({ dir }).admit(command()).kind).toBe("ambiguous")
  })
})

describe("durable command effects", () => {
  test("a command killed after started is refused on restart with no second effect", async () => {
    const dir = stateDir()
    const child = Bun.spawn(["bun", "-e", startedThenWaitCode], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, LEDGER_DIR: dir, CMD_JSON: JSON.stringify(command()) },
      stdout: "pipe",
      stderr: "pipe",
    })

    // The child wrote `started` and is still alive: kill it before it can settle.
    let seen = ""
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    while (!seen.includes("started")) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    expect(seen).toContain("started")
    child.kill(9)
    await child.exited
    expect(child.signalCode).toBe("SIGKILL")
    expect(JSON.parse(readFileSync(join(dir, "cmd-1.json"), "utf8")).status).toBe("started")

    const counting = countingDriver()
    const executor = new Executor({ runtime: runtime(counting.driver), ledgerDir: dir })
    const outcome = await executor.execute(command(), context())

    expect(outcome.status).toBe("failed")
    expect(outcome.error?.code).toBe("ambiguous_replay")
    expect(counting.connected()).toBe(0)
  })

  test("a lost completion returns the cached result on re-lease", async () => {
    const dir = stateDir()
    const counting = countingDriver()
    const first = new Executor({ runtime: runtime(counting.driver), ledgerDir: dir })
    const run = await first.execute(command(), context())
    expect(run.status).toBe("succeeded")
    expect(counting.connected()).toBe(1)

    // The completion response was lost; the hub re-leases after a restart.
    const second = new Executor({ runtime: runtime(counting.driver), ledgerDir: dir })
    expect(await second.execute(command(), context())).toEqual(run)
    expect(counting.connected()).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, "cmd-1.json"), "utf8")).status).toBe("succeeded")
  })

  test("a terminal failure is served from the ledger", async () => {
    const dir = stateDir()
    let connected = 0
    const failing: RuntimeDriver = {
      async connect() {
        connected += 1
        throw new Error("harness missing")
      },
    }
    const executor = new Executor({ runtime: runtime(failing), ledgerDir: dir })
    const outcome = await executor.execute(command(), context())
    expect(outcome.status).toBe("failed")
    expect(connected).toBe(1)

    expect(await executor.execute(command(), context())).toEqual(outcome)
    expect(connected).toBe(1)
  })
})

describe("ledger compaction", () => {
  const write = (dir: string, name: string, entry: Record<string, unknown>, updatedAt: Date): string => {
    const path = join(dir, `${name}.json`)
    writeFileSync(path, JSON.stringify({ commandId: name, fingerprint: "f", ...entry, updatedAt: updatedAt.toISOString() }))
    utimesSync(path, updatedAt, updatedAt)
    return path
  }

  test("drops old terminal entries and retains every started entry", () => {
    const dir = stateDir()
    const ledger = new CommandLedger({ dir })
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    const fresh = new Date()

    write(dir, "old-terminal", { status: "succeeded", result: {} }, old)
    write(dir, "old-started", { status: "started" }, old)
    write(dir, "new-terminal", { status: "failed", error: { code: "x", message: "y" } }, fresh)

    expect(ledger.compact()).toBe(1)
    expect(() => readFileSync(join(dir, "old-terminal.json"))).toThrow()
    // A `started` entry is never dropped, however old.
    expect(JSON.parse(readFileSync(join(dir, "old-started.json"), "utf8")).status).toBe("started")
    expect(() => readFileSync(join(dir, "new-terminal.json"))).not.toThrow()
  })

  test("automatic compaction is throttled to the configured interval", () => {
    const dir = stateDir()
    const ledger = new CommandLedger({ dir, compactIntervalMs: 60_000 })
    write(dir, "old-terminal", { status: "succeeded", result: {} }, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000))

    ledger.admit(command())
    ledger.settle(command(), { status: "succeeded" })
    expect(() => readFileSync(join(dir, "old-terminal.json"))).not.toThrow()

    expect(ledger.compact()).toBe(1)
  })
})
