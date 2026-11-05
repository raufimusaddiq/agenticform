import type { RunEvent, RunEventBody } from "./types.ts"

/** Append-only event history that any number of consumers can read from the start. */
export class EventLog {
  private readonly events: RunEvent[] = []
  private readonly waiters = new Set<() => void>()
  private closed = false

  constructor(private readonly runId: string) {}

  append(body: RunEventBody): void {
    if (this.closed) return
    this.events.push({ ...body, runId: this.runId, seq: this.events.length + 1, at: new Date().toISOString() })
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }

  async *read(): AsyncGenerator<RunEvent> {
    let next = 0
    while (true) {
      while (next < this.events.length) yield this.events[next++]!
      if (this.closed) return
      await new Promise<void>((resolve) => this.waiters.add(resolve))
    }
  }
}
