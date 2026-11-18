import type {
  ErrorCode,
  NodeView,
  RunEventWire,
  RunRequest,
  RunStatus,
  RunView,
} from "@agenticform/protocol"

export type { ErrorCode, NodeView, RunEventWire, RunRequest, RunStatus, RunView } from "@agenticform/protocol"

/**
 * Terminal run statuses (contracts/http-api.md, "Terminal states"). A
 * `run.disconnected` event does NOT end the SSE stream: the run may be
 * recovered and continue, so disconnected is deliberately absent.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
])

/**
 * Statuses at which a thin client stops following. `disconnected` is not
 * terminal (contracts/http-api.md: the SSE stream stays open because the run
 * may be recovered and continue), but a thin client cannot recover it, so it
 * stops and reports the run for the caller to recover.
 */
export const FOLLOW_STOP_STATUSES: ReadonlySet<RunStatus> = new Set([
  ...TERMINAL_RUN_STATUSES,
  "disconnected",
])

/** Fallback error code for a non-JSON or unknown-status error response. */
const STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  400: "invalid_input",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "idempotency_conflict",
  413: "payload_too_large",
  422: "invalid_input",
}

/** A hub error response, surfaced as-is. Thin clients add no policy. */
export class HubApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "HubApiError"
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
  url: string
  /** Admin bearer token. Never placed in a URL, argv or log. */
  token: string
  fetch?: FetchLike
}

/** Validate a resume cursor: events start at seq 1, so `after` is a non-negative integer. */
export function normalizeAfter(value: unknown): number {
  const after =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN
  if (!Number.isInteger(after) || after < 0) throw new Error("after must be a non-negative integer")
  return after
}

export const MAX_FOLLOW_RETRIES = 5

/**
 * Wait before reconnect `retriesMade` (0-based). Bounded: 100ms doubling to
 * 5s, and it gives up once `MAX_FOLLOW_RETRIES` retries have been made.
 */
export async function reconnectDelay(retriesMade: number): Promise<void> {
  if (retriesMade >= MAX_FOLLOW_RETRIES) {
    throw new Error(`event stream did not advance after ${MAX_FOLLOW_RETRIES} retries`)
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** retriesMade, 5_000)))
}


/** Thin transport over the hub HTTP API. No placement, retry or state logic. */
export class HubClient {
  readonly url: string
  private readonly token: string
  private readonly fetchImpl: FetchLike

  constructor(options: ClientOptions) {
    this.url = options.url.replace(/\/+$/, "")
    this.token = options.token
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(this.url + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return (await this.read<T>(response)) as T
  }

  private async read<T>(response: Response): Promise<T | undefined> {
    if (response.status === 204) return undefined
    const text = await response.text()
    if (!response.ok) {
      let value: unknown
      try {
        value = text ? (JSON.parse(text) as unknown) : undefined
      } catch {
        value = undefined
      }
      const error = (value as { error?: { code?: string; message?: string } } | undefined)?.error
      const fallback = text.length > 200 ? `${text.slice(0, 200)}…` : text
      const message =
        error?.message ?? (response.statusText || fallback || `hub responded with ${response.status}`)
      throw new HubApiError(
        error?.code ?? STATUS_CODES[response.status] ?? "internal",
        message,
        response.status,
      )
    }
    if (!text) {
      throw new HubApiError(
        "internal",
        `hub returned a non-JSON body with status ${response.status}`,
        response.status,
      )
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new HubApiError(
        "internal",
        `hub returned a non-JSON body with status ${response.status}`,
        response.status,
      )
    }
  }

  async listNodes(): Promise<NodeView[]> {
    const body = await this.request<{ nodes: NodeView[] }>("GET", "/v1/nodes")
    return body.nodes
  }

  createRun(request: RunRequest): Promise<RunView> {
    return this.request<RunView>("POST", "/v1/runs", request)
  }

  getRun(runId: string): Promise<RunView> {
    return this.request<RunView>("GET", `/v1/runs/${encodeURIComponent(runId)}`)
  }

  cancelRun(runId: string): Promise<RunView> {
    return this.request<RunView>("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`)
  }

  async getEvents(
    runId: string,
    after: number = 0,
  ): Promise<{ events: RunEventWire[]; lastSeq: number }> {
    const cursor = normalizeAfter(after)
    return this.request<{ events: RunEventWire[]; lastSeq: number }>(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/events?after=${cursor}`,
    )
  }

  /**
   * Follow the SSE stream once, resuming from `after` via `Last-Event-ID`.
   * Returns the last seq seen. A dropped connection is the caller's to resume;
   * no hidden retry loop.
   */
  async followEvents(
    runId: string,
    after: number,
    onEvent: (event: RunEventWire) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    const cursor = normalizeAfter(after)
    const response = await this.fetchImpl(
      `${this.url}/v1/runs/${encodeURIComponent(runId)}/events?after=${cursor}&stream=sse`,
      {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "text/event-stream",
          "last-event-id": String(cursor),
        },
        ...(signal ? { signal } : {}),
      },
    )
    if (!response.ok) {
      await this.read<never>(response)
      return cursor
    }
    if (!response.body) return cursor
    const decoder = new TextDecoder()
    let buffer = ""
    let last = cursor
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let split: number
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!data) continue
        const event = JSON.parse(data) as RunEventWire
        last = event.seq
        onEvent(event)
        if (signal?.aborted) return last
      }
    }
    return last
  }
}
