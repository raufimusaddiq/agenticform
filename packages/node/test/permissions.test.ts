import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandEnvelope, RunEventInput } from "@agenticform/protocol"
import {
  createRuntime,
  type Capabilities,
  type DriverConnection,
  type RuntimeDriver,
} from "@agenticform/runtime"
import { createHub, type Hub } from "../../hub/src/index.ts"
import type { HubConfig } from "../../hub/src/config.ts"
import { NodeClient } from "../src/client.ts"
import type { NodeConfig } from "../src/config.ts"
import { Executor } from "../src/executor.ts"
import { generateKeyPair, type NodeIdentity } from "../src/identity.ts"
import { startPoller, type Poller } from "../src/poller.ts"
import { fingerprintOf } from "../src/state.ts"

/** The Executor refuses every run without a passing self-test (FR-014). */
const SANDBOX = { mode: "bwrap", selfTest: "pass" } as const

const supported: Capabilities["supported"] = {
  cancel: true,
  "steer.emulated": false,
  "mcp.stdio": false,
  "mcp.http": false,
  "mcp.sse": false,
  "session.load": false,
  "session.resume": false,
  "prompt.image": false,
  "prompt.embeddedContext": false,
}

/**
 * A driver that asks permission the way the ACP driver does: emit
 * `permission.requested`, await `sink.decide` (the runtime's own handler and
 * timeout), then emit `permission.resolved`. The harness is in-process, so the
 * test needs no sandbox binary; the runtime, executor and ledger are real.
 */
const permissionDriver = (): RuntimeDriver => ({
  async connect(_input, sink): Promise<DriverConnection> {
    return {
      capabilities: { protocolVersion: 1, agent: { name: "fake", version: "1" }, supported },
      async openSession() {},
      async prompt() {
        const request = { toolCallId: "tool-1", title: "Write file", kind: "edit" }
        sink.emit({ type: "permission.requested", request })
        const decision = await sink.decide(request)
        sink.emit({ type: "permission.resolved", toolCallId: request.toolCallId, decision })
        sink.emit({ type: "message.delta", text: decision })
        return { stopReason: "end_turn" }
      },
      async cancel() {},
      async close() {},
      stderrTail() {
        return ""
      },
    }
  },
})

const executor = (permissionTimeoutMs?: number): Executor =>
  new Executor({
    isolation: SANDBOX,
    runtime: createRuntime({
      driver: permissionDriver(),
      harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } },
    }),
    ...(permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs }),
  })

/** Builds a command with the payload fingerprint the node recomputes (N5.3). */
const command = (overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => {
  const payload = {
    fingerprint: "",
    generation: 1,
    harness: "fake",
    cwd: tmpdir(),
    prompt: "go",
    requires: [],
    mcpServers: [],
    ...overrides.payload,
  }
  const envelope: CommandEnvelope = {
    commandId: "cmd-1",
    type: "run.start",
    runId: "run-1",
    generation: 1,
    idempotencyKey: "run:run-1:run.start:1",
    leasedUntil: new Date(Date.now() + 60_000).toISOString(),
    leaseId: "lease-1",
    ...overrides,
    payload,
  }
  return { ...envelope, payload: { ...payload, fingerprint: fingerprintOf(envelope) } }
}

const answerCommand = (decision: "allow" | "deny", commandId = `answer-${decision}`): CommandEnvelope =>
  command({
    commandId,
    type: "permission.answer",
    idempotencyKey: "run:run-1:permission.answer:tool-1:1",
    payload: { fingerprint: "", generation: 1, toolCallId: "tool-1", decision },
  })

const waitUntil = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const start = Date.now()
  while (!condition() && Date.now() - start < timeoutMs) await Bun.sleep(10)
}

const context = (events: RunEventInput[]) => ({
  emit: (event: RunEventInput) => events.push(event),
  signal: new AbortController().signal,
})

describe("remote permission answers (T021)", () => {
  test("allow reaches the harness", async () => {
    const events: RunEventInput[] = []
    const node = executor()
    const running = node.execute(command(), context(events))
    await waitUntil(() => events.some((event) => event.type === "permission.requested"))
    const answered = await node.execute(answerCommand("allow"), context([]))
    expect(answered).toEqual({ status: "succeeded", result: { applied: true } })
    const outcome = await running
    expect(outcome.result).toMatchObject({ status: "completed", text: "allow" })
    expect(events.some((event) => event.type === "permission.resolved")).toBe(true)
  })

  test("deny reaches the harness", async () => {
    const events: RunEventInput[] = []
    const node = executor()
    const running = node.execute(command(), context(events))
    await waitUntil(() => events.some((event) => event.type === "permission.requested"))
    expect(await node.execute(answerCommand("deny"), context([]))).toEqual({
      status: "succeeded",
      result: { applied: true },
    })
    expect((await running).result).toMatchObject({ text: "deny" })
  })

  test("no answer is denied at the runtime's timeout", async () => {
    const events: RunEventInput[] = []
    const node = executor(50)
    const outcome = await node.execute(command(), context(events))
    expect(outcome.result).toMatchObject({ text: "deny" })
    // The waiter is gone, so a late answer is not applied.
    expect(await node.execute(answerCommand("allow"), context([]))).toEqual({
      status: "succeeded",
      result: { applied: false },
    })
  })

  test("a duplicate answer completes applied:false", async () => {
    const events: RunEventInput[] = []
    const node = executor()
    const running = node.execute(command(), context(events))
    await waitUntil(() => events.some((event) => event.type === "permission.requested"))
    const first = await node.execute(answerCommand("allow", "answer-1"), context([]))
    const second = await node.execute(answerCommand("allow", "answer-2"), context([]))
    expect(first).toEqual({ status: "succeeded", result: { applied: true } })
    expect(second).toEqual({ status: "succeeded", result: { applied: false } })
    await running
  })

  test("an answer for an unknown request is applied:false, not an error", async () => {
    const outcome = await executor().execute(answerCommand("allow"), context([]))
    expect(outcome).toEqual({ status: "succeeded", result: { applied: false } })
  })

  test("a restarted node never re-asks and cannot apply an old answer", async () => {
    const events: RunEventInput[] = []
    const before = executor(50)
    await before.execute(command(), context(events))
    expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(1)
    // A restart is a fresh executor: waiters were memory only, so nothing is
    // replayed and the old answer has nothing to resolve.
    const after = executor()
    expect(await after.execute(answerCommand("allow"), context([]))).toEqual({
      status: "succeeded",
      result: { applied: false },
    })
  })
})

// A real hub over HTTP with real signatures, and a real node poller/executor.
// The harness is the in-process driver above, so no sandbox binary is needed.
const hubConfig = (): HubConfig => ({
  adminToken: "test-admin-token-0123456789abcdef",
  publicUrl: null,
  stateFile: join(mkdtempSync(join(tmpdir(), "af-perm-hub-")), "hub.sqlite"),
  port: 0,
  clockSkewMs: 120_000,
  heartbeatIntervalMs: 15_000,
  nodeOfflineMs: 45_000,
  enrollmentTtlMs: 600_000,
  nonceTtlMs: 600_000,
  nonceCleanupMs: 600_000,
  leaseMs: 900_000,
  pollMs: 1_500,
  recoveryGraceMs: 120_000,
  maxBodyBytes: 1_048_576,
  maxDepth: 3,
})

const nodeConfig = (hubUrl: string): NodeConfig => ({
  hubUrl,
  stateDir: mkdtempSync(join(tmpdir(), "af-perm-node-")),
  heartbeatIntervalMs: 15_000,
  pollMs: 20,
  leaseRenewMs: 60_000,
  requestTimeoutMs: 5_000,
  harnessProbeTtlMs: 300_000,
  harnessProbeReadyTtlMs: 3_600_000,
  harnessProbeTimeoutMs: 20_000,
  protocolVersion: 1,
})

const adminHeaders = (hub: Hub): Record<string, string> => ({
  authorization: `Bearer ${hub.config.adminToken}`,
  "content-type": "application/json",
})

async function enroll(hub: Hub, capabilities: string[]): Promise<{ client: NodeClient; nodeId: string }> {
  const keys = generateKeyPair()
  const issued = (await (
    await fetch(`${hub.url}/v1/enrollment-tokens`, { method: "POST", headers: adminHeaders(hub) })
  ).json()) as { token: string }
  const enrolled = (await (
    await fetch(`${hub.url}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: issued.token,
        name: "node-1",
        publicKey: keys.publicKeyB64,
        protocolVersion: 1,
        harnesses: ["fake"],
      }),
    })
  ).json()) as { nodeId: string }
  const identity: NodeIdentity = { ...keys, nodeId: enrolled.nodeId, hubUrl: hub.url }
  const client = new NodeClient(nodeConfig(hub.url), identity)
  await client.heartbeat({
    protocolVersion: 1,
    harnesses: ["fake"],
    capabilities,
    capacity: { slots: 1, inUse: 0 },
    runtimes: [],
  })
  return { client, nodeId: enrolled.nodeId }
}

async function startRun(hub: Hub, nodeId: string, key: string): Promise<string> {
  const response = await fetch(`${hub.url}/v1/runs`, {
    method: "POST",
    headers: adminHeaders(hub),
    body: JSON.stringify({ idempotencyKey: key, harness: "fake", prompt: "go", cwd: tmpdir(), nodeId }),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { runId: string }).runId
}

const getRun = async (hub: Hub, runId: string): Promise<{ status: string }> =>
  (await (await fetch(`${hub.url}/v1/runs/${runId}`, { headers: adminHeaders(hub) })).json()) as {
    status: string
  }

const getPermissions = async (
  hub: Hub,
  runId: string,
): Promise<{ permissions: { requestId: string; status: string; decision: string | null }[] }> =>
  (await (
    await fetch(`${hub.url}/v1/runs/${runId}/permissions`, { headers: adminHeaders(hub) })
  ).json()) as { permissions: { requestId: string; status: string; decision: string | null }[] }

const answer = (hub: Hub, runId: string, requestId: string, decision: string): Promise<Response> =>
  fetch(`${hub.url}/v1/runs/${runId}/permissions/${requestId}`, {
    method: "POST",
    headers: adminHeaders(hub),
    body: JSON.stringify({ decision }),
  })

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const start = Date.now()
  while (!(await condition()) && Date.now() - start < timeoutMs) await Bun.sleep(20)
}

describe("real hub and node (T021)", () => {
  test("an answer is leased while the single start slot is busy", async () => {
    const hub = createHub(hubConfig())
    let poller: Poller | undefined
    try {
      const { client, nodeId } = await enroll(hub, ["permissions.remote"])
      const runId = await startRun(hub, nodeId, "perm-e2e")
      const executor = new Executor({
        isolation: SANDBOX,
        runtime: createRuntime({
          driver: permissionDriver(),
          harnesses: { fake: { id: "fake", profile: "coding", command: process.execPath } },
        }),
      })
      poller = startPoller(client, { pollMs: 20, leaseRenewMs: 60_000, executor, slots: 1 })

      await waitFor(async () =>
        (await getPermissions(hub, runId)).permissions.some((view) => view.status === "pending"),
      )
      // The one start slot is held by the running run, which is waiting for the
      // answer; the answer still reaches it through the control lane.
      expect((await getRun(hub, runId)).status).toBe("running")

      const answered = await answer(hub, runId, "tool-1", "allow")
      expect(answered.status).toBe(200)

      await waitFor(async () => (await getRun(hub, runId)).status === "completed")
      const [view] = (await getPermissions(hub, runId)).permissions
      expect(view).toMatchObject({ requestId: "tool-1", status: "resolved", decision: "allow" })

      const command = hub.db
        .query<{ status: string; result_json: string }, [string]>(
          "SELECT status, result_json FROM commands WHERE run_id = ? AND type = 'permission.answer'",
        )
        .get(runId)
      expect(command?.status).toBe("succeeded")
      expect(JSON.parse(command?.result_json as string)).toEqual({ applied: true })
    } finally {
      await poller?.stop()
      hub.stop()
    }
  })

  test("a node without permissions.remote is refused", async () => {
    const hub = createHub(hubConfig())
    try {
      const { client, nodeId } = await enroll(hub, [])
      const runId = await startRun(hub, nodeId, "perm-unsupported")
      const command = await client.nextCommand()
      expect(command).not.toBeNull()
      await client.appendEvents(command?.commandId as string, {
        leaseId: command?.leaseId as string,
        events: [
          {
            key: "c1:1",
            type: "permission.requested",
            at: new Date().toISOString(),
            data: {
              type: "permission.requested",
              turnId: "t1",
              request: { toolCallId: "tool-1", title: "Write file", kind: "edit" },
            },
          },
        ],
      })
      const refused = await answer(hub, runId, "tool-1", "allow")
      expect(refused.status).toBe(409)
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        "permission_unsupported",
      )
    } finally {
      hub.stop()
    }
  })
})
