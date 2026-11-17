import { expect } from "bun:test"
import { createRuntime, type HarnessDefinition, type RunEvent, type RunInput } from "../src/index.ts"

export interface ConformanceTarget {
  /** Builds the harness for one behaviour. Real harnesses cannot script every case. */
  harness(scenario: string): HarnessDefinition
  cwd: string
  prompt: string
}

const collect = async (events: AsyncIterable<RunEvent>) => {
  const seen: RunEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

const start = (target: ConformanceTarget, scenario: string, input: Partial<RunInput> = {}) =>
  createRuntime().run({ harness: target.harness(scenario), cwd: target.cwd, prompt: target.prompt, ...input })

const waitFor = async (run: ReturnType<typeof start>, type: RunEvent["type"]) => {
  for await (const event of run.events()) if (event.type === type) return event
  throw new Error(`Run ended without ${type}`)
}

/** The same cases apply to every harness. `scripted` cases need an agent that can be told how to behave. */
export const conformance = {
  handshake: {
    scripted: false,
    run: async (target: ConformanceTarget) => {
      const run = start(target, "ok")
      const event = await waitFor(run, "run.capabilities")
      await run.cancel()
      expect(event.type).toBe("run.capabilities")
    },
  },
  prompt: {
    scripted: false,
    run: async (target: ConformanceTarget) => {
      const run = start(target, "ok")
      const events = await collect(run.events())
      const result = await run.result()
      expect(result.status).toBe("completed")
      expect(result.text.length).toBeGreaterThan(0)
      expect(events.at(-1)?.type).toBe("run.finished")
      expect(events.filter((event) => event.type === "run.finished")).toHaveLength(1)
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
    },
  },
  cancel: {
    scripted: true,
    run: async (target: ConformanceTarget) => {
      const run = start(target, "cancellable")
      await waitFor(run, "message.delta")
      await run.cancel()
      expect((await run.result()).status).toBe("cancelled")
    },
  },
  permissionDeniedByDefault: {
    scripted: true,
    run: async (target: ConformanceTarget) => {
      const run = start(target, "permission")
      const result = await run.result()
      expect(result.text).toBe("no")
    },
  },
  permissionAllowed: {
    scripted: true,
    run: async (target: ConformanceTarget) => {
      const run = start(target, "permission", { onPermission: () => "allow" })
      const result = await run.result()
      expect(result.text).toBe("once")
    },
  },
  processDeath: {
    scripted: true,
    run: async (target: ConformanceTarget) => {
      const result = await start(target, "exit").result()
      expect(result.status).toBe("failed")
      expect(result.error?.code).toBe("process_exited")
    },
  },
  capabilityRefusal: {
    scripted: true,
    run: async (target: ConformanceTarget) => {
      const run = start(target, "ok", { requires: ["session.load"] })
      const events = await collect(run.events())
      const result = await run.result()
      expect(result.error?.code).toBe("capability_missing")
      expect(events.some((event) => event.type === "turn.started")).toBe(false)
    },
  },
}
