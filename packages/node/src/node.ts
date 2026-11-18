import type { Runtime } from "@agenticform/runtime"
import { NodeClient, type ClientOptions } from "./client.ts"
import type { NodeConfig } from "./config.ts"
import { Executor } from "./executor.ts"
import { startHeartbeat, type HeartbeatLoop } from "./heartbeat.ts"
import type { NodeIdentity } from "./identity.ts"
import { startPoller, type Poller } from "./poller.ts"

export interface NodeOptions {
  runtime?: Runtime
  capabilities?: string[]
  harnesses?: string[]
  slots?: number
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
  const executor = new Executor(options.runtime ? { runtime: options.runtime } : {})
  const capabilities = options.capabilities ?? []
  const harnesses = options.harnesses
  const slots = options.slots ?? 1
  const onError = options.onError ?? logError
  const advertised = (): string[] => {
    const available = executor.harnesses()
    return harnesses && harnesses.length > 0
      ? available.filter((harness) => harnesses.includes(harness))
      : available
  }

  let heartbeat: HeartbeatLoop | undefined
  let poller: Poller | undefined

  return {
    client,
    executor,
    start() {
      if (heartbeat || poller) return
      heartbeat = startHeartbeat(client, {
        intervalMs: config.heartbeatIntervalMs,
        body: () => ({
          protocolVersion: config.protocolVersion,
          status: "online",
          harnesses: advertised(),
          capabilities,
          capacity: { slots, inUse: executor.activeCount },
          runtimes: executor.inventory(),
        }),
        onError,
      })
      poller = startPoller(client, {
        pollMs: config.pollMs,
        leaseRenewMs: config.leaseRenewMs,
        executor,
        onError,
      })
    },
    async stop() {
      heartbeat?.stop()
      heartbeat = undefined
      await poller?.stop()
      poller = undefined
      await executor.stop()
    },
  }
}
