import { loadConfigFile } from "@agenticform/protocol/config"
import type {
  CallerTokenView,
  ErrorCode,
  IssuedCallerToken,
  NodeView,
  PermissionRequestView,
  RunEventWire,
  RunRequest,
  RunStatus,
  RunView,
  WorkflowError,
  WorkflowLimits,
  WorkflowRequest,
  WorkflowStatus,
  WorkflowView,
} from "@agenticform/protocol"

export type {
  CallerTokenView,
  ErrorCode,
  IssuedCallerToken,
  NodeView,
  PermissionRequestView,
  RunEventWire,
  RunRequest,
  RunStatus,
  RunView,
  WorkflowError,
  WorkflowLimits,
  WorkflowRequest,
  WorkflowStatus,
  WorkflowView,
} from "@agenticform/protocol"

export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
])

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

/**
 * The bearer token from the environment first, then the config file.
 * Never from argv, a URL or a query parameter (FR-005).
 */
export function envToken(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.AGENTICFORM_ADMIN_TOKEN || env.AGENTICFORM_TOKEN) {
    return env.AGENTICFORM_ADMIN_TOKEN || env.AGENTICFORM_TOKEN || undefined
  }
  const file = loadConfigFile(env)
  return file.adminToken || file.token || undefined
}

/** Resolve both hub URL and bearer token with env > config.json precedence. */
export function resolveClientConfig(
  env: Record<string, string | undefined> = process.env,
): { url: string | undefined; token: string | undefined } {
  const file = loadConfigFile(env)
  const url = env.AGENTICFORM_HUB_URL || file.hubUrl || undefined
  const token = env.AGENTICFORM_ADMIN_TOKEN || env.AGENTICFORM_TOKEN || file.adminToken || file.token || undefined
  return { url, token }
}

export interface ClientOptions {
  url: string
  /** Admin bearer token. Never placed in a URL, argv or log. */
  token: string
  fetch?: FetchLike
}

/** Validate a resume cursor: events start at seq 1, so `after` is a non-negative integer. */
export function normalizeAfter(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new Error("after must be a non-negative integer")
    return value
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  throw new Error("after must be a non-negative integer")
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
    const body = await this.request<{ nodes: NodeView[] } | undefined>("GET", "/v1/nodes")
    return body?.nodes ?? []
  }

  /** Issue a `runs` token. The returned `token` is the only copy (FR-004). */
  issueToken(name: string): Promise<IssuedCallerToken> {
    return this.request<IssuedCallerToken>("POST", "/v1/tokens", { name, scope: "runs" })
  }

  async listTokens(): Promise<CallerTokenView[]> {
    const body = await this.request<{ tokens: CallerTokenView[] } | undefined>("GET", "/v1/tokens")
    return body?.tokens ?? []
  }

  revokeToken(id: string): Promise<CallerTokenView> {
    return this.request<CallerTokenView>("POST", `/v1/tokens/${encodeURIComponent(id)}/revoke`)
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

  createWorkflow(request: WorkflowRequest): Promise<WorkflowView> {
    return this.request<WorkflowView>("POST", "/v1/workflows", request)
  }

  async listWorkflows(): Promise<WorkflowView[]> {
    const body = await this.request<{ workflows: WorkflowView[] } | undefined>("GET", "/v1/workflows")
    return body?.workflows ?? []
  }

  getWorkflow(workflowId: string): Promise<WorkflowView> {
    return this.request<WorkflowView>("GET", `/v1/workflows/${encodeURIComponent(workflowId)}`)
  }

  cancelWorkflow(workflowId: string): Promise<WorkflowView> {
    return this.request<WorkflowView>("POST", `/v1/workflows/${encodeURIComponent(workflowId)}/cancel`)
  }

  async listPermissions(runId: string): Promise<PermissionRequestView[]> {
    const body = await this.request<{ permissions: PermissionRequestView[] } | undefined>(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/permissions`,
    )
    return body?.permissions ?? []
  }

  /** Answer a pending request. Only the admin token may call this (FR-008). */
  answerPermission(
    runId: string,
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<PermissionRequestView> {
    return this.request<PermissionRequestView>(
      "POST",
      `/v1/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(requestId)}`,
      { decision },
    )
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
    const dispatch = (frame: string): boolean => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
      if (!data) return false
      const event = JSON.parse(data) as RunEventWire
      // The hub ends a revoked follow with `event: error` and no seq (FR-003).
      if (typeof event.seq !== "number") {
        const code = (event as unknown as { code?: string }).code ?? "internal"
        throw new HubApiError(code, code, code === "unauthorized" ? 401 : 500)
      }
      last = event.seq
      onEvent(event)
      return signal?.aborted === true
    }
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      // Accept LF and CRLF framing, including a CRLF split across chunks.
      buffer = buffer.replace(/\r\n/g, "\n")
      let split: number
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        if (dispatch(frame)) return last
      }
    }
    // Flush a final frame that arrived without the trailing blank line.
    buffer += decoder.decode()
    if (dispatch(buffer)) return last
    return last
  }
}
