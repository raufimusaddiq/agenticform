import type { HeartbeatRequest, HeartbeatResponse } from "@agenticform/protocol"
import type { NodeClient } from "./client.ts"

export interface HeartbeatOptions {
  intervalMs: number
  body: () => HeartbeatRequest | Promise<HeartbeatRequest>
  onResponse?: (response: HeartbeatResponse) => void
  onError?: (error: unknown) => void
}

export interface HeartbeatLoop {
  stop(): Promise<void>
  tick(): Promise<void>
}

/**
 * Pull, never push (N1.2): the node heartbeats on an interval and the hub can
 * never open a connection to it. A failed beat is logged and retried; it never
 * stops the daemon. `stop` aborts an in-flight beat and waits for it.
 */
export function startHeartbeat(client: NodeClient, options: HeartbeatOptions): HeartbeatLoop {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: Promise<void> | undefined
  const controller = new AbortController()

  const tick = async (): Promise<void> => {
    if (stopped) return
    // A forced beat (for example after a probe lands) joins the in-flight beat
    // instead of sending a duplicate.
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const response = await client.heartbeat(await options.body(), controller.signal)
        options.onResponse?.(response)
      } catch (error) {
        if (!stopped) options.onError?.(error)
      }
    })()
    try {
      await inflight
    } finally {
      inflight = undefined
    }
  }

  const loop = async (): Promise<void> => {
    await tick()
    if (!stopped) timer = setTimeout(() => void loop(), options.intervalMs)
  }
  void loop()

  return {
    tick,
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      controller.abort(new Error("heartbeat stopped"))
      await inflight
    },
  }
}
