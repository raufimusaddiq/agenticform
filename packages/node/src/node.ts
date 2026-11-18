import { join } from "node:path"
import type { HarnessDefinition, Runtime } from "@agenticform/runtime"
import { createRuntime } from "@agenticform/runtime"
import { NodeClient, type ClientOptions } from "./client.ts"
import type { NodeConfig } from "./config.ts"
import { Executor } from "./executor.ts"
import { HarnessProber } from "./harness-probe.ts"
import { startHeartbeat, type HeartbeatLoop } from "./heartbeat.ts"
import type { NodeIdentity } from "./identity.ts"
import { startPoller, type Poller } from "./poller.ts"

export interface NodeOptions {
  runtime?: Runtime
  capabilities?: string[]
  harnesses?: string[]
  slots?: number
  stopTimeoutMs?: number
  fetch?: typeof fetch
  onError?: (error: unknown) => void
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

/**
 * Wires the outbound daemon: signed client, heartbeat, poller and executor.
 * Nothing here listens; every connection is initiated by the node (FR-001).
 */
export function createNode(config: NodeConfig, identity: NodeIdentity, options: NodeOptions = {}): Node {
  const clientOptions: ClientOptions = {}
  if (options.fetch) clientOptions.fetch = options.fetch
  const client = new NodeClient(config, identity, clientOptions)
  const runtime = options.runtime ?? createRuntime()
  const harnesses = options.harnesses
  const configured = (): HarnessDefinition[] => {
    const all = runtime.harnesses()
    return harnesses && harnesses.length > 0 ? all.filter((harness) => harnesses.includes(harness.id)) : all
  }
  // FR-017..FR-022: probe each configured harness, advertise only the ready
  // ones, and report every one. The probe runs in the background so a hung
  // harness cannot stall the heartbeat.
  const prober = new HarnessProber({
    definitions: configured,
    ttlMs: config.harnessProbeTtlMs,
    timeoutMs: config.harnessProbeTimeoutMs,
  })
  const executor = new Executor({
    runtime,
    ledgerDir: join(config.stateDir, "ledger"),
    harnessStatus: (id) => prober.status(id),
    harnessFailed: (id) => prober.invalidate(id),
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
      void prober.refresh()
      heartbeat = startHeartbeat(client, {
        intervalMs: config.heartbeatIntervalMs,
        body: () => {
          void prober.refresh()
          return {
            protocolVersion: config.protocolVersion,
            status: "online",
            harnesses: advertised(),
            capabilities,
            capacity: { slots, inUse: executor.activeCount },
            runtimes: executor.inventory(),
            harnessReport: prober.report(),
          }
        },
        onError,
      })
      // Advertise a harness as soon as its first probe lands, rather than
      // waiting a whole heartbeat interval.
      void prober.refresh().then(() => heartbeat?.tick())
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
