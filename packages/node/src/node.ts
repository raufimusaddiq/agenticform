import { join } from "node:path"
import { isolationProfileVersion } from "@agenticform/protocol"
import type { HarnessDefinition, Runtime } from "@agenticform/runtime"
import { createRuntime } from "@agenticform/runtime"
import { NodeClient, type ClientOptions } from "./client.ts"
import type { NodeConfig } from "./config.ts"
import { validateAdvertisements } from "./config.ts"
import { Executor } from "./executor.ts"
import { HarnessProber } from "./harness-probe.ts"
import { startHeartbeat, type HeartbeatLoop } from "./heartbeat.ts"
import type { NodeIdentity } from "./identity.ts"
import { PROFILE_VERSION, startupSelfTest, type SelfTestResult } from "./isolation.ts"
import { startPoller, type Poller } from "./poller.ts"

export interface NodeOptions {
  runtime?: Runtime
  capabilities?: string[]
  harnesses?: string[]
  slots?: number
  stopTimeoutMs?: number
  fetch?: typeof fetch
  onError?: (error: unknown) => void
  /** Home used to resolve harness entry points; defaults to the process home. */
  home?: string
  /** Environment used to resolve harness entry points; defaults to the process env. */
  env?: Record<string, string | undefined>
  /** Startup self-test result; defaults to the process-wide one (FR-013). */
  isolation?: SelfTestResult
}

export interface Node {
  client: NodeClient
  executor: Executor
  start(): void
  stop(): Promise<void>
}

const logError = (error: unknown): void => {
  console.error("node:", error instanceof Error ? error.message : error)
}

/** Resolve after `ms` or when `signal` aborts, even if `work` has not settled. */
const bounded = async (work: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  const aborted = new Promise<void>((resolve) => {
    if (!signal) return
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
  try {
    await Promise.race([work, timeout, aborted])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wires the outbound daemon: signed client, heartbeat, poller and executor.
 * Nothing here listens; every connection is initiated by the node (FR-001).
 */
export function createNode(config: NodeConfig, identity: NodeIdentity, options: NodeOptions = {}): Node {
  const runtime = options.runtime ?? createRuntime()
  // T-34: refuse an advertisement the hub would reject, before any network call.
  validateAdvertisements({
    ...(options.harnesses === undefined ? {} : { harnesses: options.harnesses }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    catalog: runtime.harnesses().map((harness) => harness.id),
  })
  const clientOptions: ClientOptions = {}
  if (options.fetch) clientOptions.fetch = options.fetch
  const client = new NodeClient(config, identity, clientOptions)
  const harnesses = options.harnesses
  // FR-013, FR-014: prove the sandbox shape once at startup. Without it the node
  // advertises nothing and probes nothing, so no harness child is ever spawned.
  const isolation = options.isolation ?? startupSelfTest()
  const sandboxed = isolation.mode !== "none"
  const configured = (): HarnessDefinition[] => {
    if (!sandboxed) return []
    const all = runtime.harnesses()
    return harnesses && harnesses.length > 0 ? all.filter((harness) => harnesses.includes(harness.id)) : all
  }
  // FR-017..FR-022: probe each configured harness, advertise only the ready
  // ones, and report every one. The probe runs in the background so a hung
  // harness cannot stall the heartbeat.
  const prober = new HarnessProber({
    definitions: configured,
    ttlMs: config.harnessProbeTtlMs,
    readyTtlMs: config.harnessProbeReadyTtlMs,
    timeoutMs: config.harnessProbeTimeoutMs,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  const executor = new Executor({
    runtime,
    ledgerDir: join(config.stateDir, "ledger"),
    ...(harnesses === undefined ? {} : { harnesses }),
    harnessStatus: (id) => prober.status(id),
    harnessProbe: (id) => prober.ensure(id),
    harnessEntry: (id) => prober.resolved(id),
    harnessFailed: (id) => prober.invalidate(id),
    probeWaitMs: config.harnessProbeTimeoutMs + 5_000,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.env === undefined ? {} : { env: options.env }),
    isolation,
  })
  const capabilities = options.capabilities ?? []
  const slots = options.slots ?? 1
  const onError = options.onError ?? logError
  const advertised = (): string[] =>
    prober
      .report()
      .filter((report) => report.status === "ready")
      .map((report) => report.id)

  let heartbeat: HeartbeatLoop | undefined
  let poller: Poller | undefined

  return {
    client,
    executor,
    start() {
      if (heartbeat || poller) return
      // The first beat waits for the first probe pass (bounded by the probe
      // timeout), so it never advertises an empty list before the probe lands.
      let firstProbe: Promise<void> | undefined = prober.refresh()
      heartbeat = startHeartbeat(client, {
        intervalMs: config.heartbeatIntervalMs,
        body: async (signal) => {
          if (firstProbe) {
            await bounded(firstProbe, config.harnessProbeTimeoutMs, signal)
            firstProbe = undefined
          }
          void prober.refresh().catch(onError)
          return {
            protocolVersion: config.protocolVersion,
            status: "online",
            harnesses: advertised(),
            capabilities,
            capacity: { slots, inUse: executor.activeCount },
            runtimes: executor.inventory(),
            harnessReport: prober.report(),
            isolation: {
              mode: isolation.mode,
              profile: isolationProfileVersion(PROFILE_VERSION),
              selfTest: isolation.selfTest,
            },
          }
        },
        onError,
      })
      poller = startPoller(client, {
        pollMs: config.pollMs,
        leaseRenewMs: config.leaseRenewMs,
        executor,
        slots,
        ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
        onError,
      })
    },
    async stop() {
      await heartbeat?.stop()
      heartbeat = undefined
      await poller?.stop()
      poller = undefined
      await executor.stop()
    },
  }
}
