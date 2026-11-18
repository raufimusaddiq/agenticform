import type { CommandEnvelope, CompletionRequest } from "@agenticform/protocol"
import { NodeClientError, type NodeClient } from "./client.ts"
import { EventBatcher } from "./events.ts"
import type { ExecutionOutcome, Executor } from "./executor.ts"

export interface PollerOptions {
  pollMs: number
  leaseRenewMs: number
  executor: Executor
  onError?: (error: unknown) => void
}

export interface Poller {
  stop(): Promise<void>
  tick(): Promise<void>
}

/**
 * Pulls commands and runs them concurrently, so a `run.cancel` can be leased
 * while a `run.start` is still executing. Each command renews its own lease and
 * flushes its own event batch; a lost completion is left to lease expiry and
 * redelivery (the ledger makes that safe in a later task).
 */
export function startPoller(client: NodeClient, options: PollerOptions): Poller {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const inflight = new Set<Promise<void>>()

  const complete = async (
    command: CommandEnvelope,
    outcome: ExecutionOutcome,
    batcher: EventBatcher,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body: CompletionRequest = {
        leaseId: command.leaseId,
        status: outcome.status,
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(batcher.lastSeq > 0 ? { eventsToSeq: batcher.lastSeq } : {}),
      }
      try {
        await client.complete(command.commandId, body)
        return
      } catch (error) {
        if (error instanceof NodeClientError && error.code === "events_pending") {
          await batcher.flush()
          continue
        }
        throw error
      }
    }
  }

  const handle = async (command: CommandEnvelope): Promise<void> => {
    const controller = new AbortController()
    const batcher = new EventBatcher({
      send: (events) => client.appendEvents(command.commandId, { leaseId: command.leaseId, events }),
      ...(options.onError ? { onError: options.onError } : {}),
    })
    const renew = setInterval(() => {
      void client.renew(command.commandId).catch((error) => controller.abort(error))
    }, Math.max(1_000, options.leaseRenewMs))

    try {
      const outcome = await options.executor.execute(command, {
        emit: (event) => batcher.add(event),
        signal: controller.signal,
      })
      await batcher.close()
      await complete(command, outcome, batcher)
    } catch (error) {
      options.onError?.(error)
      await batcher.close().catch(() => {})
      const failure: ExecutionOutcome = {
        status: "failed",
        error: { code: "internal", message: error instanceof Error ? error.message : "execution failed" },
      }
      await complete(command, failure, batcher).catch((completionError) => options.onError?.(completionError))
    } finally {
      clearInterval(renew)
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    const command = await client.nextCommand()
    if (!command) return
    const task = handle(command)
      .catch((error) => options.onError?.(error))
      .finally(() => inflight.delete(task))
    inflight.add(task)
  }

  let backoff = options.pollMs
  const loop = async (): Promise<void> => {
    try {
      await tick()
      backoff = options.pollMs
    } catch (error) {
      options.onError?.(error)
      backoff = Math.min(Math.max(backoff, 1_000) * 2, 30_000)
    }
    if (!stopped) timer = setTimeout(() => void loop(), backoff)
  }
  void loop()

  return {
    tick,
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      await Promise.allSettled([...inflight])
    },
  }
}
