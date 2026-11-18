import type { HeartbeatRequest, HeartbeatResponse } from "@agenticform/protocol"
import type { NodeClient } from "./client.ts"

export interface HeartbeatOptions {
  intervalMs: number
  body: () => HeartbeatRequest | Promise<HeartbeatRequest>
  onResponse?: (response: HeartbeatResponse) => void
  onError?: (error: unknown) => void
}

export interface HeartbeatLoop {
  stop(): void
  tick(): Promise<void>
}

/**
 * Pull, never push (N1.2): the node heartbeats on an interval and the hub can
 * never open a connection to it. A failed beat is logged and retried; it never
 * stops the daemon.
 */
export function startHeartbeat(client: NodeClient, options: HeartbeatOptions): HeartbeatLoop {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const response = await client.heartbeat(await options.body())
      options.onResponse?.(response)
    } catch (error) {
      options.onError?.(error)
    }
  }

  const loop = async (): Promise<void> => {
    await tick()
    if (!stopped) timer = setTimeout(() => void loop(), options.intervalMs)
  }
  void loop()

  return {
    tick,
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
