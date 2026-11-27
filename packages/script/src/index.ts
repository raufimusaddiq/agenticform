import {
  Host,
  HostFailure,
  Runtime,
  SnapshotError,
  fromBytes,
  parseProgram,
  toBytes,
  type Diagnostic,
  type Json,
  type Run,
} from "psychoscript"
import type {
  NodeView,
  PermissionPolicy,
  PermissionRequestView,
  RunEventWire,
  RunRequest,
  RunStatus,
  RunView,
  WorkflowLimits,
} from "@agenticform/protocol"

const SuspendError = Runtime.SuspendError
type Outcome = Runtime.Outcome
type Result = Runtime.Result
type Suspended = Runtime.Suspended

export { SnapshotError, SuspendError, fromBytes, toBytes }
export type { Diagnostic, Json, Result, Suspended }

export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000
export const DEFAULT_SCRIPT_MAX_OUTPUT_BYTES = 65_536
export const DEFAULT_SCRIPT_MAX_SNAPSHOT_BYTES = 524_288
export const DEFAULT_SCRIPT_MAX_CHILD_RUNS = 20
export const DEFAULT_POLL_INTERVAL_MS = 100

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
])

const ALLOWED_RUN_KEYS = new Set([
  "idempotencyKey",
  "harness",
  "prompt",
  "cwd",
  "requires",
  "mcpServers",
  "nodeId",
  "labels",
  "gitBacked",
  "permissionPolicy",
])

export interface ScriptRunsPort {
  listNodes(): Promise<NodeView[]>
  createRun(request: RunRequest): Promise<RunView>
  getRun(runId: string): Promise<RunView>
  cancelRun(runId: string): Promise<RunView>
  getEvents(runId: string, after?: number): Promise<{ events: RunEventWire[]; lastSeq: number }>
  listPermissions(runId: string): Promise<PermissionRequestView[]>
  waitForRun?(runId: string, signal: AbortSignal): Promise<RunView>
}

export interface ScriptRuntimeOptions {
  limits?: WorkflowLimits
  parentRunId?: string | null
  pollIntervalMs?: number
  onChildRun?: (runId: string) => void
  onDurableWait?: (runId: string) => void
}

export type ScriptSuspendedOutcome = Suspended & {
  readonly bytes: Uint8Array
}

export type ScriptOutcome = Result | ScriptSuspendedOutcome

export interface ScriptProgram {
  run(options?: { readonly signal?: AbortSignal | undefined }): Promise<ScriptOutcome>
  suspend(options?: { readonly maxBytes?: number | undefined }): Promise<ScriptOutcome>
}

export interface ScriptCompileResult {
  readonly ok: true
}

export interface ScriptCompileFailure {
  readonly ok: false
  readonly error: Diagnostic
}

export interface ScriptRuntime {
  compile(code: string): ScriptCompileResult | ScriptCompileFailure
  execute(
    code: string,
    options?: {
      readonly runId?: string | undefined
      readonly bindings?: Readonly<Record<string, Json>> | undefined
      readonly signal?: AbortSignal | undefined
    },
  ): Promise<Result>
  program(
    code: string,
    options?: {
      readonly runId?: string | undefined
      readonly bindings?: Readonly<Record<string, Json>> | undefined
    },
  ): ScriptProgram
  resume(saved: Suspended["state"] | Uint8Array): ScriptProgram
}

export function validateScript(code: string): ScriptCompileResult | ScriptCompileFailure {
  if (typeof code !== "string" || code.trim().length === 0) {
    return {
      ok: false,
      error: {
        kind: "SyntaxError",
        message: "script code must be a non-empty string",
      },
    }
  }
  const parsed = parseProgram(code)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true }
}

function normalizeLimit(value: number | undefined, fallback: number, name: string, min = 1): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a safe integer >= ${min}`)
  }
  return value
}

function readChildRunIds(run: Run): string[] {
  const raw = run.metadata
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Array.isArray((raw as { childRunIds?: unknown }).childRunIds)
  ) {
    return ((raw as { childRunIds: unknown[] }).childRunIds).filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    )
  }
  run.metadata = { childRunIds: [] }
  return []
}

function recordChildRun(
  run: Run,
  runId: string,
  onChildRun?: (runId: string) => void,
): void {
  const existing = readChildRunIds(run)
  if (!existing.includes(runId)) {
    run.metadata = { childRunIds: [...existing, runId] }
  }
  onChildRun?.(runId)
}

function toHostError(error: unknown): HostFailure {
  if (error instanceof HostFailure) return error
  if (error !== null && typeof error === "object" && "code" in error && "message" in error) {
    const code = (error as { code?: unknown }).code
    const message = (error as { message?: unknown }).message
    if (typeof code === "string" && typeof message === "string") {
      return Host.fail(code, message)
    }
  }
  return Host.fail("HostError", error instanceof Error ? error.message : String(error))
}

async function wrapHostCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw toHostError(error)
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw Host.fail("InvalidInput", `${field} must be a non-empty string`)
  }
  return value
}

function parseRunRequest(
  raw: unknown,
  defaultKey: string,
  runId: string,
  parentRunId: string | null | undefined,
): RunRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw Host.fail("InvalidInput", "run request must be an object")
  }
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_RUN_KEYS.has(key)) {
      throw Host.fail("InvalidInput", `unknown run option: ${key}`)
    }
  }

  const harness = requireNonEmptyString(obj.harness, "harness")
  const prompt = requireNonEmptyString(obj.prompt, "prompt")

  let idempotencyKey = defaultKey
  if (obj.idempotencyKey !== undefined) {
    const userKey = requireNonEmptyString(obj.idempotencyKey, "idempotencyKey")
    idempotencyKey = `${runId}:${userKey}`
  }

  const request: RunRequest = {
    idempotencyKey,
    harness,
    prompt,
  }

  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string") throw Host.fail("InvalidInput", "cwd must be a string")
    request.cwd = obj.cwd
  }
  if (obj.nodeId !== undefined) {
    if (typeof obj.nodeId !== "string") throw Host.fail("InvalidInput", "nodeId must be a string")
    request.nodeId = obj.nodeId
  }
  if (obj.requires !== undefined) {
    if (!Array.isArray(obj.requires) || obj.requires.some((item) => typeof item !== "string")) {
      throw Host.fail("InvalidInput", "requires must be an array of strings")
    }
    request.requires = obj.requires as string[]
  }
  if (obj.mcpServers !== undefined) {
    if (!Array.isArray(obj.mcpServers)) {
      throw Host.fail("InvalidInput", "mcpServers must be an array")
    }
    request.mcpServers = obj.mcpServers as unknown[]
  }
  if (obj.labels !== undefined) {
    if (
      obj.labels === null ||
      typeof obj.labels !== "object" ||
      Array.isArray(obj.labels) ||
      Object.values(obj.labels).some((value) => typeof value !== "string")
    ) {
      throw Host.fail("InvalidInput", "labels must be a flat string map")
    }
    request.labels = obj.labels as Record<string, string>
  }
  if (obj.gitBacked !== undefined) {
    if (typeof obj.gitBacked !== "boolean") {
      throw Host.fail("InvalidInput", "gitBacked must be a boolean")
    }
    request.gitBacked = obj.gitBacked
  }
  if (obj.permissionPolicy !== undefined) {
    if (
      obj.permissionPolicy !== "allow" &&
      obj.permissionPolicy !== "ask" &&
      obj.permissionPolicy !== "deny"
    ) {
      throw Host.fail("InvalidInput", "permissionPolicy must be allow, ask or deny")
    }
    request.permissionPolicy = obj.permissionPolicy as PermissionPolicy
  }
  if (parentRunId) {
    request.parentRunId = parentRunId
  }

  return request
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function pollUntilTerminal(
  port: ScriptRunsPort,
  runId: string,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<RunView | undefined> {
  while (!signal.aborted) {
    const view = await wrapHostCall(() => port.getRun(runId))
    if (TERMINAL_RUN_STATUSES.has(view.status)) return view
    await sleepAbortable(pollIntervalMs, signal)
  }
  return undefined
}

function mapOutcome(outcome: Outcome): ScriptOutcome {
  if (outcome.ok === "suspended") {
    return {
      ok: "suspended",
      state: outcome.state,
      bytes: toBytes(outcome.state),
    }
  }
  return outcome
}

export function createScriptRuntime(
  port: ScriptRunsPort,
  options: ScriptRuntimeOptions = {},
): ScriptRuntime {
  const timeoutMs = normalizeLimit(options.limits?.timeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS, "timeoutMs", 1)
  const maxOutputBytes = normalizeLimit(
    options.limits?.maxOutputBytes,
    DEFAULT_SCRIPT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
    0,
  )
  const maxSnapshotBytes = normalizeLimit(
    options.limits?.maxSnapshotBytes,
    DEFAULT_SCRIPT_MAX_SNAPSHOT_BYTES,
    "maxSnapshotBytes",
    1,
  )
  const maxChildRuns = normalizeLimit(
    options.limits?.maxChildRuns,
    DEFAULT_SCRIPT_MAX_CHILD_RUNS,
    "maxChildRuns",
    0,
  )
  const pollIntervalMs = normalizeLimit(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
    1,
  )

  const runtime = Runtime.make({
    limits: { timeoutMs, maxOutputBytes },
    translate: { functions: "error", promises: "error" },
    globals: (run) => {
      // Ensure metadata has a valid JSON shape on both initial start and resume.
      readChildRunIds(run)

      const ensureChildBudget = (): void => {
        if (readChildRunIds(run).length >= maxChildRuns) {
          throw Host.fail(
            "LimitExceeded",
            `workflow exceeded maxChildRuns limit of ${maxChildRuns}`,
          )
        }
      }

      return {
        af: {
          run: Host.durableFn<{ runId: string }>({
            start: async ([raw], call) => {
              ensureChildBudget()
              const request = parseRunRequest(raw, call.key, run.id, options.parentRunId)
              const created = await wrapHostCall(() => port.createRun(request))
              recordChildRun(run, created.runId, options.onChildRun)
              return { runId: created.runId }
            },
            wait: async ({ runId }, call) => {
              const current = await wrapHostCall(() => port.getRun(runId))
              if (TERMINAL_RUN_STATUSES.has(current.status)) return current
              options.onDurableWait?.(runId)
              if (port.waitForRun) {
                return await wrapHostCall(() => port.waitForRun!(runId, call.signal))
              }
              return await pollUntilTerminal(port, runId, pollIntervalMs, call.signal)
            },
            cancel: async ({ runId }) => {
              try {
                await port.cancelRun(runId)
              } catch {
                // Cancellation cleanup must be best-effort and never throw or leak secrets.
              }
            },
          }),
          startRun: Host.fn(
            async ([raw], call) => {
              ensureChildBudget()
              const request = parseRunRequest(raw, call.key, run.id, options.parentRunId)
              const created = await wrapHostCall(() => port.createRun(request))
              recordChildRun(run, created.runId, options.onChildRun)
              return created
            },
            { type: "async", idempotent: true },
          ),
          getRun: Host.fn(
            async ([runId]) => {
              const id = requireNonEmptyString(runId, "runId")
              return await wrapHostCall(() => port.getRun(id))
            },
            { type: "async", idempotent: true },
          ),
          cancelRun: Host.fn(
            async ([runId]) => {
              const id = requireNonEmptyString(runId, "runId")
              return await wrapHostCall(() => port.cancelRun(id))
            },
            { type: "async", idempotent: true },
          ),
          listNodes: Host.fn(
            async () => await wrapHostCall(() => port.listNodes()),
            { type: "async", idempotent: true },
          ),
          listEvents: Host.fn(
            async ([runId, after]) => {
              const id = requireNonEmptyString(runId, "runId")
              if (after !== undefined) {
                if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
                  throw Host.fail("InvalidInput", "after must be a non-negative integer")
                }
              }
              return await wrapHostCall(() => port.getEvents(id, after))
            },
            { type: "async", idempotent: true },
          ),
          listPermissions: Host.fn(
            async ([runId]) => {
              const id = requireNonEmptyString(runId, "runId")
              return await wrapHostCall(() => port.listPermissions(id))
            },
            { type: "async", idempotent: true },
          ),
        },
      }
    },
  })

  const wrapProgram = (program: ReturnType<typeof runtime.program>): ScriptProgram => ({
    run: async (runOptions) => {
      const outcome = await program.run(runOptions)
      return mapOutcome(outcome)
    },
    suspend: async (suspendOptions) => {
      const maxBytes = suspendOptions?.maxBytes ?? maxSnapshotBytes
      const outcome = await program.suspend({ maxBytes })
      return mapOutcome(outcome)
    },
  })

  return {
    compile: validateScript,
    execute: (code, execOptions) => runtime.execute(code, execOptions),
    program: (code, programOptions) => wrapProgram(runtime.program(code, programOptions)),
    resume: (saved) => {
      const state = saved instanceof Uint8Array ? fromBytes(saved) : saved
      return wrapProgram(runtime.resume(state as Suspended["state"]))
    },
  }
}
