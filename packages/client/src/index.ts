import type {
  NodeView,
  RunEventWire,
  RunRequest,
  RunView,
} from "@agenticform/protocol"

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

export interface ClientOptions {
  url: string
  /** Admin bearer token. Never placed in a URL, argv or log. */
  token: string
  fetch?: typeof fetch
}

/** Thin transport over the hub HTTP API. No placement, retry or state logic. */
export class HubClient {
  readonly url: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: ClientOptions) {
    this.url = options.url.replace(/\/+$/, "")
    this.token = options.token
    this.fetchImpl = options.fetch ?? fetch
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
    const value = text ? (JSON.parse(text) as unknown) : undefined
    if (!response.ok) {
      const error = (value as { error?: { code?: string; message?: string } } | undefined)?.error
      throw new HubApiError(
        error?.code ?? "internal",
        error?.message ?? `hub responded with ${response.status}`,
        response.status,
      )
    }
    return value as T
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

  async getEvents(runId: string, after = 0): Promise<{ events: RunEventWire[]; lastSeq: number }> {
    return this.request<{ events: RunEventWire[]; lastSeq: number }>(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`,
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
    const response = await this.fetchImpl(
      `${this.url}/v1/runs/${encodeURIComponent(runId)}/events?after=${after}&stream=sse`,
      {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "text/event-stream",
          "last-event-id": String(after),
        },
        ...(signal ? { signal } : {}),
      },
    )
    if (!response.ok) {
      await this.read<never>(response)
      return after
    }
    if (!response.body) return after
    const decoder = new TextDecoder()
    let buffer = ""
    let cursor = after
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
        cursor = event.seq
        onEvent(event)
      }
    }
    return cursor
  }
}
