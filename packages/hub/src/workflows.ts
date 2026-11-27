import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type {
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
import {
  SnapshotError,
  SuspendError,
  createScriptRuntime,
  validateScript,
  type Json,
  type ScriptProgram,
  type ScriptRunsPort,
  type ScriptRuntime,
} from "@agenticform/script"
import type { HubConfig } from "./config.ts"
import { HubError, fail } from "./errors.ts"
import { listEvents } from "./events.ts"
import { listNodes } from "./nodes.ts"
import { listPermissions } from "./permissions.ts"
import { cancelRun, createRun, getRun, runView } from "./runs.ts"
import type { RunRow, WorkflowRow } from "./schema.ts"

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
])

const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
])

const ALLOWED_LIMIT_KEYS = new Set([
  "timeoutMs",
  "maxOutputBytes",
  "maxSnapshotBytes",
  "maxChildRuns",
])

interface ResolvedLimits {
  timeoutMs: number
  maxOutputBytes: number
  maxSnapshotBytes: number
  maxChildRuns: number
}

interface ActiveWorkflow {
  id: string
  program: ScriptProgram
  controller: AbortController
  limits: ResolvedLimits
  childRunIds: Set<string>
  waitingRunIds: Set<string>
  parkTimer: ReturnType<typeof setTimeout> | undefined
  done: Promise<void>
  cancelling: boolean
  closing: boolean
  parkError: WorkflowError | undefined
}

function normalizeWorkflowRequest(request: WorkflowRequest): string {
  const bindings = request.bindings ?? {}
  const sortedBindings: Record<string, unknown> = {}
  for (const key of Object.keys(bindings).sort()) {
    sortedBindings[key] = bindings[key]
  }
  const limits = request.limits ?? {}
  return JSON.stringify({
    idempotencyKey: request.idempotencyKey,
    code: request.code,
    bindings: sortedBindings,
    parentRunId: request.parentRunId ?? null,
    limits: {
      timeoutMs: limits.timeoutMs ?? null,
      maxOutputBytes: limits.maxOutputBytes ?? null,
      maxSnapshotBytes: limits.maxSnapshotBytes ?? null,
      maxChildRuns: limits.maxChildRuns ?? null,
    },
  })
}

function validatePositiveOrZeroInt(
  value: unknown,
  name: string,
  min: number,
  cap: number,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    fail("invalid_input", `${name} must be an integer >= ${min}`)
  }
  if (value > cap) {
    fail("workflow_limit_exceeded", `${name} ${value} exceeds hub cap of ${cap}`)
  }
  return value
}

function validateAndResolveLimits(
  rawLimits: unknown,
  config: HubConfig,
): { requested: WorkflowLimits; resolved: ResolvedLimits } {
  if (rawLimits === undefined) {
    return {
      requested: {},
      resolved: {
        timeoutMs: config.workflowTimeoutMs,
        maxOutputBytes: config.workflowMaxOutputBytes,
        maxSnapshotBytes: config.workflowMaxSnapshotBytes,
        maxChildRuns: config.workflowMaxChildRuns,
      },
    }
  }
  if (rawLimits === null || typeof rawLimits !== "object" || Array.isArray(rawLimits)) {
    fail("invalid_input", "limits must be an object")
  }
  const obj = rawLimits as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_LIMIT_KEYS.has(key)) fail("invalid_input", `unknown limit: ${key}`)
  }
  const timeoutMs = validatePositiveOrZeroInt(
    obj.timeoutMs,
    "limits.timeoutMs",
    1,
    config.workflowTimeoutMs,
  )
  const maxOutputBytes = validatePositiveOrZeroInt(
    obj.maxOutputBytes,
    "limits.maxOutputBytes",
    0,
    config.workflowMaxOutputBytes,
  )
  const maxSnapshotBytes = validatePositiveOrZeroInt(
    obj.maxSnapshotBytes,
    "limits.maxSnapshotBytes",
    1,
    config.workflowMaxSnapshotBytes,
  )
  const maxChildRuns = validatePositiveOrZeroInt(
    obj.maxChildRuns,
    "limits.maxChildRuns",
    0,
    config.workflowMaxChildRuns,
  )
  const requested: WorkflowLimits = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes }),
    ...(maxChildRuns === undefined ? {} : { maxChildRuns }),
  }
  return {
    requested,
    resolved: {
      timeoutMs: timeoutMs ?? config.workflowTimeoutMs,
      maxOutputBytes: maxOutputBytes ?? config.workflowMaxOutputBytes,
      maxSnapshotBytes: maxSnapshotBytes ?? config.workflowMaxSnapshotBytes,
      maxChildRuns: maxChildRuns ?? config.workflowMaxChildRuns,
    },
  }
}

function validateBindings(raw: unknown): Record<string, Json> {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("invalid_input", "bindings must be a plain JSON object")
  }
  try {
    return JSON.parse(JSON.stringify(raw)) as Record<string, Json>
  } catch {
    fail("invalid_input", "bindings must be JSON-serializable")
  }
}

function parseIdList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
  } catch {
    return []
  }
}

function isHubErrorCode(error: unknown, code: string): boolean {
  return error instanceof HubError && error.code === code
}

export function workflowView(row: WorkflowRow): WorkflowView {
  const view: WorkflowView = {
    workflowId: row.id,
    status: row.status as WorkflowStatus,
    parentRunId: row.parent_run_id,
    depth: row.depth,
    childRunIds: parseIdList(row.child_run_ids_json),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  }
  if (row.result_json !== null) view.result = JSON.parse(row.result_json) as unknown
  if (row.error_json !== null) view.error = JSON.parse(row.error_json) as WorkflowError
  if (row.logs_json !== null) view.logs = JSON.parse(row.logs_json) as string[]
  if (row.truncated !== 0) view.truncated = true
  return view
}

export class WorkflowManager {
  private readonly active = new Map<string, ActiveWorkflow>()
  private readonly waitersByRunId = new Map<string, Set<(run: RunView) => void>>()
  private readonly resuming = new Set<string>()
  private closed = false
  private draining = false

  constructor(
    private readonly db: Database,
    private readonly config: HubConfig,
  ) {}

  private isRunTerminal(runId: string): boolean {
    const row = this.db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)
    return row !== null && TERMINAL_RUN_STATUSES.has(row.status as RunStatus)
  }

  private createPort(parentRunId: string | null): ScriptRunsPort {
    return {
      listNodes: async () => listNodes(this.db),
      createRun: async (request: RunRequest) => {
        const finalRequest: RunRequest = parentRunId ? { ...request, parentRunId } : request
        return runView(this.db, createRun(this.db, finalRequest, this.config).run)
      },
      getRun: async (runId: string) => runView(this.db, getRun(this.db, runId)),
      cancelRun: async (runId: string) => runView(this.db, cancelRun(this.db, runId).run),
      getEvents: async (runId: string, after = 0): Promise<{ events: RunEventWire[]; lastSeq: number }> => {
        getRun(this.db, runId)
        const events = listEvents(this.db, runId, after)
        return { events, lastSeq: events.at(-1)?.seq ?? after }
      },
      listPermissions: async (runId: string) => listPermissions(this.db, runId),
      waitForRun: async (runId: string, signal: AbortSignal) => {
        const current = runView(this.db, getRun(this.db, runId))
        if (TERMINAL_RUN_STATUSES.has(current.status)) return current
        if (signal.aborted) return current
        return await new Promise<RunView>((resolve) => {
          let set = this.waitersByRunId.get(runId)
          if (!set) {
            set = new Set()
            this.waitersByRunId.set(runId, set)
          }
          const finish = (view: RunView) => {
            signal.removeEventListener("abort", onAbort)
            set?.delete(finish)
            if (set && set.size === 0) this.waitersByRunId.delete(runId)
            resolve(view)
          }
          const onAbort = () => {
            set?.delete(finish)
            if (set && set.size === 0) this.waitersByRunId.delete(runId)
            resolve(current)
          }
          set.add(finish)
          signal.addEventListener("abort", onAbort, { once: true })
          // Re-check in case the run finished between the first query and registering.
          const latest = runView(this.db, getRun(this.db, runId))
          if (TERMINAL_RUN_STATUSES.has(latest.status)) finish(latest)
        })
      },
    }
  }

  private buildRuntime(
    entryRef: { current?: ActiveWorkflow },
    limits: ResolvedLimits,
    parentRunId: string | null,
  ): ScriptRuntime {
    return createScriptRuntime(this.createPort(parentRunId), {
      limits,
      parentRunId,
      onChildRun: (runId) => {
        const entry = entryRef.current
        if (!entry) return
        entry.childRunIds.add(runId)
        if (this.closed) return
        this.db
          .query("UPDATE workflows SET child_run_ids_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify([...entry.childRunIds]), Date.now(), entry.id)
      },
      onDurableWait: (runId) => {
        const entry = entryRef.current
        if (!entry) return
        entry.waitingRunIds.add(runId)
        if (this.closed || this.draining || entry.cancelling || entry.closing) return
        this.schedulePark(entry)
      },
    })
  }

  private schedulePark(entry: ActiveWorkflow): void {
    if (entry.parkTimer !== undefined || entry.cancelling || entry.closing || this.closed) return
    entry.parkTimer = setTimeout(() => {
      entry.parkTimer = undefined
      void this.parkEntry(entry)
    }, this.config.workflowParkMs)
  }

  private async parkEntry(entry: ActiveWorkflow): Promise<void> {
    if (this.closed || entry.closing || entry.cancelling) return
    if (this.active.get(entry.id) !== entry) return
    try {
      await entry.program.suspend({ maxBytes: entry.limits.maxSnapshotBytes })
    } catch (error) {
      if (this.closed || entry.closing || entry.cancelling) return
      if (error instanceof SuspendError) {
        if (error.running.length > 0) {
          this.schedulePark(entry)
          return
        }
        entry.parkError = { kind: "LimitExceeded", message: error.message }
        entry.controller.abort("snapshot_limit_exceeded")
        return
      }
      entry.parkError = {
        kind: error instanceof Error ? error.name : "SuspendFailed",
        message: error instanceof Error ? error.message : String(error),
      }
      entry.controller.abort("suspend_failed")
    }
  }

  private launch(
    row: WorkflowRow,
    limits: ResolvedLimits,
    mode: "start" | "resume",
  ): void {
    if (this.closed) return
    const entryRef: { current?: ActiveWorkflow } = {}
    const scriptRuntime = this.buildRuntime(entryRef, limits, row.parent_run_id)
    let program: ScriptProgram
    try {
      if (mode === "start") {
        const bindings = JSON.parse(row.bindings_json) as Record<string, Json>
        program = scriptRuntime.program(row.code, { runId: row.id, bindings })
      } else {
        if (row.snapshot_bytes === null) {
          throw new SnapshotError("workflow snapshot is missing")
        }
        program = scriptRuntime.resume(row.snapshot_bytes)
      }
    } catch (error) {
      const kind = error instanceof SnapshotError ? "SnapshotError" : "WorkflowError"
      const message = error instanceof Error ? error.message : String(error)
      const now = Date.now()
      this.db
        .query(
          `UPDATE workflows SET status = 'failed', snapshot_bytes = NULL, waiting_run_ids_json = '[]',
             error_json = ?, updated_at = ?, completed_at = ?
           WHERE id = ? AND status IN ('running','suspended')`,
        )
        .run(JSON.stringify({ kind, message }), now, now, row.id)
      return
    }

    const controller = new AbortController()
    const entry: ActiveWorkflow = {
      id: row.id,
      program,
      controller,
      limits,
      childRunIds: new Set(parseIdList(row.child_run_ids_json)),
      waitingRunIds: new Set(),
      parkTimer: undefined,
      done: Promise.resolve(),
      cancelling: false,
      closing: false,
      parkError: undefined,
    }
    entryRef.current = entry
    this.active.set(row.id, entry)

    entry.done = (async () => {
      try {
        const outcome = await program.run({ signal: controller.signal })
        if (this.closed || entry.closing || entry.cancelling) return
        const now = Date.now()
        const childJson = JSON.stringify([...entry.childRunIds])
        if (outcome.ok === "suspended") {
          const waitingList = [...entry.waitingRunIds].filter((runId) => !this.isRunTerminal(runId))
          // Keep any waiting ids that were already recorded if all turned terminal right during suspend,
          // so the immediate check below can trigger resume cleanly.
          const waitingJson = JSON.stringify([...entry.waitingRunIds])
          this.db
            .query(
              `UPDATE workflows SET status = 'suspended', snapshot_bytes = ?, child_run_ids_json = ?,
                 waiting_run_ids_json = ?, updated_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(outcome.bytes, childJson, waitingJson, now, entry.id)
          if (
            !this.draining &&
            !this.closed &&
            entry.waitingRunIds.size > 0 &&
            waitingList.length < entry.waitingRunIds.size
          ) {
            queueMicrotask(() => this.resumeWorkflow(entry.id))
          }
          return
        }
        const logsJson = outcome.logs ? JSON.stringify(outcome.logs) : null
        const truncated = outcome.truncated ? 1 : 0
        if (outcome.ok) {
          const resultValue = outcome.value === undefined ? null : outcome.value
          this.db
            .query(
              `UPDATE workflows SET status = 'completed', snapshot_bytes = NULL, child_run_ids_json = ?,
                 waiting_run_ids_json = '[]', result_json = ?, error_json = NULL, logs_json = ?,
                 truncated = ?, updated_at = ?, completed_at = ?
               WHERE id = ?`,
            )
            .run(childJson, JSON.stringify(resultValue), logsJson, truncated, now, now, entry.id)
        } else {
          this.db
            .query(
              `UPDATE workflows SET status = 'failed', snapshot_bytes = NULL, child_run_ids_json = ?,
                 waiting_run_ids_json = '[]', result_json = NULL, error_json = ?, logs_json = ?,
                 truncated = ?, updated_at = ?, completed_at = ?
               WHERE id = ?`,
            )
            .run(childJson, JSON.stringify(outcome.error), logsJson, truncated, now, now, entry.id)
        }
      } catch (error) {
        if (this.closed || entry.closing) return
        const now = Date.now()
        const childJson = JSON.stringify([...entry.childRunIds])
        if (entry.cancelling) {
          this.db
            .query(
              `UPDATE workflows SET status = 'cancelled', snapshot_bytes = NULL, child_run_ids_json = ?,
                 waiting_run_ids_json = '[]', updated_at = ?, completed_at = ?
               WHERE id = ? AND status IN ('running','suspended')`,
            )
            .run(childJson, now, now, entry.id)
          return
        }
        if (entry.parkError) {
          this.db
            .query(
              `UPDATE workflows SET status = 'failed', snapshot_bytes = NULL, child_run_ids_json = ?,
                 waiting_run_ids_json = '[]', error_json = ?, updated_at = ?, completed_at = ?
               WHERE id = ?`,
            )
            .run(childJson, JSON.stringify(entry.parkError), now, now, entry.id)
          return
        }
        if (error instanceof Error && error.name === "AbortError") {
          this.db
            .query(
              `UPDATE workflows SET status = 'cancelled', snapshot_bytes = NULL, child_run_ids_json = ?,
                 waiting_run_ids_json = '[]', updated_at = ?, completed_at = ?
               WHERE id = ? AND status IN ('running','suspended')`,
            )
            .run(childJson, now, now, entry.id)
          return
        }
        const kind =
          error instanceof SnapshotError
            ? "SnapshotError"
            : error instanceof Error
              ? error.name
              : "WorkflowError"
        const message = error instanceof Error ? error.message : String(error)
        this.db
          .query(
            `UPDATE workflows SET status = 'failed', snapshot_bytes = NULL, child_run_ids_json = ?,
               waiting_run_ids_json = '[]', error_json = ?, updated_at = ?, completed_at = ?
             WHERE id = ?`,
          )
          .run(childJson, JSON.stringify({ kind, message }), now, now, entry.id)
      } finally {
        if (entry.parkTimer !== undefined) {
          clearTimeout(entry.parkTimer)
          entry.parkTimer = undefined
        }
        if (this.active.get(entry.id) === entry) {
          this.active.delete(entry.id)
        }
      }
    })()
  }

  createWorkflow(request: WorkflowRequest, now = Date.now()): { workflow: WorkflowRow; created: boolean } {
    if (typeof request.idempotencyKey !== "string" || !request.idempotencyKey) {
      fail("invalid_input", "idempotencyKey is required")
    }
    if (typeof request.code !== "string" || !request.code.trim()) {
      fail("invalid_input", "code is required")
    }
    if (Buffer.byteLength(request.code, "utf8") > this.config.workflowMaxCodeBytes) {
      fail(
        "workflow_limit_exceeded",
        `script code exceeds max size of ${this.config.workflowMaxCodeBytes} bytes`,
      )
    }
    if (request.parentRunId !== undefined) {
      if (typeof request.parentRunId !== "string" || !request.parentRunId) {
        fail("invalid_input", "parentRunId must be a non-empty string")
      }
    }
    const bindings = validateBindings(request.bindings)
    const { requested, resolved } = validateAndResolveLimits(request.limits, this.config)
    const normalizedInput: WorkflowRequest = {
      idempotencyKey: request.idempotencyKey,
      code: request.code,
      bindings,
      limits: requested,
      ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
    }
    const requestJson = normalizeWorkflowRequest(normalizedInput)

    const existing = this.db
      .query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE idempotency_key = ?")
      .get(request.idempotencyKey)
    if (existing) {
      if (existing.request_json !== requestJson) {
        fail("idempotency_conflict", "idempotency key reused with a different payload")
      }
      return { workflow: existing, created: false }
    }

    let depth = 0
    if (request.parentRunId !== undefined) {
      const parent = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(request.parentRunId)
      if (!parent) fail("parent_not_found", "parentRunId names no run")
      depth = parent.depth + 1
      if (depth > this.config.maxDepth) {
        fail("depth_exceeded", `run depth ${depth} exceeds the limit of ${this.config.maxDepth}`)
      }
    }

    const compiled = validateScript(request.code)
    if (!compiled.ok) {
      fail("script_invalid", compiled.error.message)
    }

    const id = randomUUID()
    const inserted = this.db
      .query(
        `INSERT OR IGNORE INTO workflows
           (id, idempotency_key, request_json, code, bindings_json, limits_json, parent_run_id, depth,
            status, snapshot_bytes, child_run_ids_json, waiting_run_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, '[]', '[]', ?, ?)`,
      )
      .run(
        id,
        request.idempotencyKey,
        requestJson,
        request.code,
        JSON.stringify(bindings),
        JSON.stringify(resolved),
        request.parentRunId ?? null,
        depth,
        now,
        now,
      )
    if (inserted.changes === 0) {
      const winner = this.db
        .query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE idempotency_key = ?")
        .get(request.idempotencyKey)
      if (winner) {
        if (winner.request_json !== requestJson) {
          fail("idempotency_conflict", "idempotency key reused with a different payload")
        }
        return { workflow: winner, created: false }
      }
    }

    const row = this.getWorkflow(id)
    queueMicrotask(() => {
      if (!this.closed && !this.draining) {
        const fresh = this.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id = ?").get(id)
        if (fresh && fresh.status === "running" && !this.active.has(id)) {
          this.launch(fresh, resolved, "start")
        }
      }
    })
    return { workflow: row, created: true }
  }

  getWorkflow(workflowId: string): WorkflowRow {
    const row = this.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id = ?").get(workflowId)
    if (!row) fail("not_found", "workflow not found")
    return row
  }

  listWorkflows(): WorkflowRow[] {
    return this.db.query<WorkflowRow, []>("SELECT * FROM workflows ORDER BY created_at DESC").all()
  }

  async cancelWorkflow(workflowId: string, now = Date.now()): Promise<WorkflowRow> {
    const row = this.getWorkflow(workflowId)
    if (TERMINAL_WORKFLOW_STATUSES.has(row.status)) return row

    const entry = this.active.get(workflowId)
    if (entry) {
      entry.cancelling = true
      if (entry.parkTimer !== undefined) {
        clearTimeout(entry.parkTimer)
        entry.parkTimer = undefined
      }
      entry.controller.abort("workflow_cancelled")
      await entry.done
      // Ensure any child runs not yet cancelled are stopped.
      for (const childId of entry.childRunIds) {
        try {
          cancelRun(this.db, childId, now)
        } catch (error) {
          if (!isHubErrorCode(error, "not_found")) throw error
        }
      }
      // Unconditional fallback in case program.run() resolved with `suspended` while parkEntry was in flight.
      this.db
        .query(
          `UPDATE workflows SET status = 'cancelled', snapshot_bytes = NULL, child_run_ids_json = ?,
             waiting_run_ids_json = '[]', updated_at = ?, completed_at = ?
           WHERE id = ? AND status IN ('running','suspended')`,
        )
        .run(JSON.stringify([...entry.childRunIds]), now, now, workflowId)
      return this.getWorkflow(workflowId)
    }

    const childIds = parseIdList(row.child_run_ids_json)
    for (const childId of childIds) {
      try {
        cancelRun(this.db, childId, now)
      } catch (error) {
        if (!isHubErrorCode(error, "not_found")) throw error
      }
    }
    this.db
      .query(
        `UPDATE workflows SET status = 'cancelled', snapshot_bytes = NULL, waiting_run_ids_json = '[]',
           updated_at = ?, completed_at = ?
         WHERE id = ? AND status IN ('running','suspended')`,
      )
      .run(now, now, workflowId)
    return this.getWorkflow(workflowId)
  }

  notifyRunChanged(runId: string): void {
    if (this.closed || this.draining) return
    const runRow = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId)
    if (!runRow) return
    const view = runView(this.db, runRow)
    if (!TERMINAL_RUN_STATUSES.has(view.status)) return

    const waiters = this.waitersByRunId.get(runId)
    if (waiters) {
      for (const resolve of [...waiters]) resolve(view)
    }

    const suspended = this.db
      .query<WorkflowRow, []>(
        "SELECT * FROM workflows WHERE status = 'suspended' AND snapshot_bytes IS NOT NULL",
      )
      .all()
    for (const row of suspended) {
      const waiting = parseIdList(row.waiting_run_ids_json)
      const tracked = waiting.length > 0 ? waiting : parseIdList(row.child_run_ids_json)
      if (tracked.includes(runId)) {
        this.resumeWorkflow(row.id)
      }
    }
  }

  private resumeWorkflow(workflowId: string): void {
    if (this.closed || this.draining) return
    if (this.active.has(workflowId) || this.resuming.has(workflowId)) return
    this.resuming.add(workflowId)
    try {
      const row = this.db
        .query<WorkflowRow, [string]>(
          "SELECT * FROM workflows WHERE id = ? AND status = 'suspended' AND snapshot_bytes IS NOT NULL",
        )
        .get(workflowId)
      if (!row) return
      const now = Date.now()
      const claimed = this.db
        .query(
          "UPDATE workflows SET status = 'running', updated_at = ? WHERE id = ? AND status = 'suspended'",
        )
        .run(now, workflowId)
      if (claimed.changes !== 1) return
      const limits = JSON.parse(row.limits_json) as ResolvedLimits
      this.launch({ ...row, status: "running", updated_at: now }, limits, "resume")
    } finally {
      this.resuming.delete(workflowId)
    }
  }

  sweep(): void {
    if (this.closed || this.draining) return
    const suspended = this.db
      .query<WorkflowRow, []>(
        "SELECT * FROM workflows WHERE status = 'suspended' AND snapshot_bytes IS NOT NULL",
      )
      .all()
    for (const row of suspended) {
      if (this.active.has(row.id) || this.resuming.has(row.id)) continue
      const waiting = parseIdList(row.waiting_run_ids_json)
      if (waiting.length === 0 || waiting.some((runId) => this.isRunTerminal(runId))) {
        this.resumeWorkflow(row.id)
      }
    }
  }

  recoverOnStartup(now = Date.now()): void {
    if (this.closed) return
    this.db
      .query(
        `UPDATE workflows SET status = 'failed',
           error_json = ?, updated_at = ?, completed_at = ?
         WHERE status = 'running' AND snapshot_bytes IS NULL`,
      )
      .run(
        JSON.stringify({
          kind: "Interrupted",
          message: "workflow interrupted without a saved snapshot; not replayed",
        }),
        now,
        now,
      )
    this.db
      .query(
        `UPDATE workflows SET status = 'suspended', updated_at = ?
         WHERE status = 'running' AND snapshot_bytes IS NOT NULL`,
      )
      .run(now)
    this.sweep()
  }

  async suspendAll(): Promise<void> {
    this.draining = true
    try {
      const entries = [...this.active.values()]
      for (const entry of entries) {
        if (entry.parkTimer !== undefined) {
          clearTimeout(entry.parkTimer)
          entry.parkTimer = undefined
        }
        try {
          await entry.program.suspend({ maxBytes: entry.limits.maxSnapshotBytes })
        } catch {
          // If a workflow cannot suspend (e.g. already completing or non-idempotent call), wait for done below.
        }
      }
      await Promise.allSettled(entries.map((entry) => entry.done))
    } finally {
      this.draining = false
    }
  }

  close(): void {
    this.closed = true
    for (const entry of this.active.values()) {
      entry.closing = true
      if (entry.parkTimer !== undefined) {
        clearTimeout(entry.parkTimer)
        entry.parkTimer = undefined
      }
      entry.controller.abort("hub_stopped")
    }
    this.active.clear()
    for (const waiters of this.waitersByRunId.values()) {
      waiters.clear()
    }
    this.waitersByRunId.clear()
  }
}
