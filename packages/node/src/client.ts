import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto"
import type {
  CommandEnvelope,
  CompletionRequest,
  EventBatch,
  EventBatchResponse,
  HeartbeatRequest,
  HeartbeatResponse,
} from "@agenticform/protocol"
import { canonicalString } from "@agenticform/protocol/canonical"
import type { NodeConfig } from "./config.ts"
import type { NodeIdentity } from "./identity.ts"

export class NodeClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "NodeClientError"
  }
}

export interface ClientOptions {
  fetch?: typeof fetch
  now?: () => number
  nonce?: () => string
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  maxAttempts?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Signed, outbound-only hub client (N2.1). Every attempt gets a fresh nonce and
 * timestamp, so a retry after a lost response is a new request, not a replay.
 * Retries cover transport errors and 5xx only; a 4xx is a decision, not a blip.
 */
export class NodeClient {
  private readonly key: KeyObject
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly nonce: () => string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly maxAttempts: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number

  constructor(
    private readonly config: NodeConfig,
    private readonly identity: NodeIdentity,
    options: ClientOptions = {},
  ) {
    this.key = createPrivateKey(identity.privateKeyPem)
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.nonce = options.nonce ?? (() => randomBytes(16).toString("hex"))
    this.sleep = options.sleep ?? defaultSleep
    this.random = options.random ?? Math.random
    this.maxAttempts = options.maxAttempts ?? 5
    this.baseBackoffMs = options.baseBackoffMs ?? 250
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
  }

  heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>("POST", "/v1/node/heartbeat", body) as Promise<HeartbeatResponse>
  }

  async nextCommand(): Promise<CommandEnvelope | null> {
    return this.request<CommandEnvelope>("GET", "/v1/node/commands/next")
  }

  renew(commandId: string): Promise<{ leasedUntil: string }> {
    return this.request<{ leasedUntil: string }>(
      "POST",
      `/v1/node/commands/${encodeURIComponent(commandId)}/renew`,
      {},
    ) as Promise<{ leasedUntil: string }>
  }

  appendEvents(commandId: string, batch: EventBatch): Promise<EventBatchResponse> {
    return this.request<EventBatchResponse>(
      "POST",
      `/v1/node/commands/${encodeURIComponent(commandId)}/events`,
      batch,
    ) as Promise<EventBatchResponse>
  }

  complete(commandId: string, body: CompletionRequest): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/v1/node/commands/${encodeURIComponent(commandId)}/complete`,
      body,
    )
  }

  private backoff(attempt: number): number {
    const ceiling = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (attempt - 1))
    return ceiling + Math.floor(this.random() * this.baseBackoffMs)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const raw = body === undefined ? "" : JSON.stringify(body)
    for (let attempt = 1; ; attempt += 1) {
      const timestamp = this.now()
      const nonce = this.nonce()
      const canonical = canonicalString({
        nodeId: this.identity.nodeId,
        timestampMs: timestamp,
        nonce,
        method,
        path,
        body: raw,
      })
      const signature = sign(null, Buffer.from(canonical), this.key).toString("base64")
      const headers: Record<string, string> = {
        "x-af-node-id": this.identity.nodeId,
        "x-af-timestamp": String(timestamp),
        "x-af-nonce": nonce,
        "x-af-signature": signature,
      }
      if (body !== undefined) headers["content-type"] = "application/json"

      try {
        const response = await this.fetchImpl(this.config.hubUrl + path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: raw }),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        })
        if (response.status === 204) return null
        if (response.ok) return (await response.json()) as T
        const error = await this.errorFrom(response)
        if (response.status >= 500 && attempt < this.maxAttempts) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw error
      } catch (error) {
        if (error instanceof NodeClientError) throw error
        if (attempt >= this.maxAttempts) throw error
        await this.sleep(this.backoff(attempt))
      }
    }
  }

  private async errorFrom(response: Response): Promise<NodeClientError> {
    try {
      const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } }
      const code = typeof body.error?.code === "string" ? body.error.code : "internal"
      const message = typeof body.error?.message === "string" ? body.error.message : "request failed"
      return new NodeClientError(response.status, code, message)
    } catch {
      return new NodeClientError(response.status, "internal", "request failed")
    }
  }
}
