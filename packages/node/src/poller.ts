import type { CommandEnvelope, CompletionRequest } from "@agenticform/protocol"
import { NodeClientError, type NodeClient } from "./client.ts"
import { EventBatcher } from "./events.ts"
import type { ExecutionOutcome, Executor } from "./executor.ts"

export interface PollerOptions {
  pollMs: number
  leaseRenewMs: number
  executor: Executor
  /** Local run.start slots; matches the capacity advertised in the heartbeat. */
  slots?: number
  onError?: (error: unknown) => void
}

export interface Poller {
  stop(): Promise<void>
  tick(): Promise<void>
}

/**
 * Pulls commands and runs them concurrently, so a `run.cancel` can be leased
 * while a `run.start` is still executing. `run.start` is gated on the local
 * slot count, so a node never runs more starts than it advertises. Each command
 * renews its own lease and flushes its own event batch; a lost completion is
 * left to lease expiry and redelivery (the ledger makes that safe in a later task).
 */
export function startPoller(client: NodeClient, options: PollerOptions): Poller {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const inflight = new Set<Promise<void>>()
  const slots = Math.max(1, options.slots ?? 1)
  let running = 0
  const waiters: (() => void)[] = []

  const acquire = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (running < slots) {
      running += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        signal.removeEventListener("abort", onAbort)
        running += 1
        resolve()
      }
      const onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(signal.reason)
      }
      signal.addEventListener("abort", onAbort, { once: true })
      waiters.push(waiter)
    })
  }

  const release = () => {
    running -= 1
    const next = waiters.shift()
    if (next) next()
  }

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
    // The hub still has not persisted every event. Surface the failure instead
    // of pretending the command completed; lease expiry redelivers it.
    throw new Error("completion still pending after retries")
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
      const isStart = command.type === "run.start"
      let acquired = false
      let outcome: ExecutionOutcome
      try {
        if (isStart) {
          await acquire(controller.signal)
          acquired = true
        }
        outcome = await options.executor.execute(command, {
          emit: (event) => batcher.add(event),
          signal: controller.signal,
        })
      } catch (error) {
        options.onError?.(error)
        outcome = {
          status: "failed",
          error: { code: "internal", message: error instanceof Error ? error.message : "execution failed" },
        }
      } finally {
        if (acquired) release()
      }

      await batcher.close().catch((error) => options.onError?.(error))
      try {
        await complete(command, outcome, batcher)
      } catch (error) {
        options.onError?.(error)
        throw error
      }
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
