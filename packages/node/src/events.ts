import type { EventBatchResponse, RunEventInput } from "@agenticform/protocol"
import type { RunEvent } from "@agenticform/runtime"

/**
 * The hub writes the single terminal `run.finished` event itself, so the node
 * never forwards the runtime's copy. Keys are stable per command and sequence,
 * so a retried batch is a no-op at the hub (N5.1).
 */
export function normaliseEvent(event: RunEvent, commandId: string): RunEventInput | null {
  if (event.type === "run.finished") return null
  const { runId: _runId, seq, at, ...data } = event
  return { key: `${commandId}:${seq}`, type: event.type, at, data }
}

export interface EventBatcherOptions {
  send: (events: RunEventInput[]) => Promise<EventBatchResponse>
  maxBatch?: number
  flushMs?: number
  onError?: (error: unknown) => void
}

/**
 * Coalesces runtime events into hub batches. `lastSeq` is the hub's last stored
 * sequence, which is what completion reports as `eventsToSeq`.
 */
export class EventBatcher {
  private pending: RunEventInput[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly maxBatch: number
  private readonly flushMs: number
  lastSeq = 0

  constructor(private readonly options: EventBatcherOptions) {
    this.maxBatch = options.maxBatch ?? 100
    this.flushMs = options.flushMs ?? 250
  }

  add(event: RunEventInput): void {
    this.pending.push(event)
    if (this.pending.length >= this.maxBatch) {
      void this.flush().catch((error) => this.options.onError?.(error))
      return
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush().catch((error) => this.options.onError?.(error))
      }, this.flushMs)
    }
  }

  /** Serialised so two flushes cannot reorder or duplicate a batch. */
  flush(): Promise<void> {
    this.queue = this.queue.catch(() => {}).then(() => this.drain())
    return this.queue
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.flush()
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, this.maxBatch)
      const response = await this.options.send(batch)
      this.pending.splice(0, batch.length)
      this.lastSeq = response.lastSeq
    }
  }
}
