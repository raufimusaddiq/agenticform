#!/usr/bin/env bun
/**
 * FR-018 soak runner (spec 004 T036/T037).
 *
 *   bun scripts/soak.ts --hours 4 --restarts 3
 *   bun scripts/soak.ts --minutes 2 --restarts 1   # smoke mode
 *
 * A real hub process, a real node (poller, executor, ledger, signatures) and a
 * real sandboxed ACP child. The run mix is complete, cancel, permission allow
 * and permission timeout; the allow and timeout mixes go through the hub's
 * permission routes, so the T-2 remote-answer path is what is measured.
 *
 * The node runs in this process so the runner can restart it on a schedule and
 * read its RSS; the hub is a child process. Harness children are bwrap
 * processes, so the orphan check is a real process-group check.
 *
 * Writes `soak-result.json` and exits non-zero on an orphan, a non-terminal run
 * or a final RSS over 120% of the baseline (SC-005).
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { createRuntime } from "../packages/runtime/src/index.ts"
import { NodeClient } from "../packages/node/src/client.ts"
import type { NodeConfig } from "../packages/node/src/config.ts"
import { Executor } from "../packages/node/src/executor.ts"
import { startHeartbeat, type HeartbeatLoop } from "../packages/node/src/heartbeat.ts"
import { generateKeyPair, type NodeIdentity } from "../packages/node/src/identity.ts"
import { startupSelfTest } from "../packages/node/src/isolation.ts"
import { startPoller, type Poller } from "../packages/node/src/poller.ts"

const TERMINAL = new Set(["completed", "failed", "cancelled"])
/** Short enough for the 2-minute smoke, long enough to observe a real wait. */
const PERMISSION_TIMEOUT_MS = 2_000
const SLOTS = 2
const GAP_MS = 100

type Kind = "complete" | "cancel" | "permission-allow" | "permission-timeout"
const KINDS: readonly Kind[] = ["complete", "cancel", "permission-allow", "permission-timeout"]

interface Options {
  hours: number
  minutes: number | null
  restarts: number
  out: string
}

interface Tracked {
  runId: string
  kind: Kind
  status: string
  answered: boolean
  unobserved: boolean
}

interface RssSample {
  at: string
  elapsedMs: number
  nodeKb: number
  hubKb: number
}

const usage = `usage: bun scripts/soak.ts [--hours N] [--minutes N] [--restarts N] [--out FILE]

  --hours     duration in hours (default 4)
  --minutes   duration in minutes; overrides --hours (smoke mode)
  --restarts  node restarts during the run (default 3)
  --out       result file (default soak-result.json)

  AGENTICFORM_SOAK_HARNESS  use a real catalog harness instead of the fake agent`

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { hours: 4, minutes: null, restarts: 3, out: "soak-result.json" }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === "--help" || flag === "-h") {
      console.log(usage)
      process.exit(0)
    }
    if (flag === "--hours" || flag === "--minutes" || flag === "--restarts" || flag === "--out") {
      if (value === undefined) throw new Error(`${flag} needs a value`)
      index += 1
      if (flag === "--out") {
        options.out = value
        continue
      }
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} must be a non-negative number`)
      if (flag === "--hours") options.hours = number
      if (flag === "--minutes") options.minutes = number
      if (flag === "--restarts") options.restarts = Math.floor(number)
      continue
    }
    throw new Error(`unknown argument: ${flag}\n\n${usage}`)
  }
  return options
}

const hasBwrap = (): boolean => Bun.spawnSync(["sh", "-c", "command -v bwrap"]).exitCode === 0

const sleep = (ms: number): Promise<void> => Bun.sleep(ms)

/** VmRSS in kB from /proc, or 0 where the host has no /proc. */
function vmRssKb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8")
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

/** Process groups of this process's children, excluding the hub. */
function childGroups(hubPid: number): number[] {
  if (process.platform !== "linux") return []
  let entries: string[]
  try {
    entries = readdirSync("/proc")
  } catch {
    return []
  }
  const groups: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === hubPid) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const close = stat.lastIndexOf(")")
      const fields = stat.slice(close + 2).split(" ")
      const ppid = Number(fields[1])
      const pgrp = Number(fields[2])
      if (ppid === process.pid && Number.isFinite(pgrp) && pgrp > 0) groups.push(pgrp)
    } catch {
      // The process exited between readdir and read.
    }
  }
  return groups
}

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const durationMs = options.minutes === null ? options.hours * 3_600_000 : options.minutes * 60_000
  if (durationMs <= 0) throw new Error("the soak needs a positive duration")
  if (!hasBwrap()) {
    console.error("soak: bwrap is required; the node refuses every run without a sandbox")
    return 2
  }

  const root = join(import.meta.dir, "..")
  const work = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "af-soak-"))
  const stateDir = join(work, "node")
  const adminToken = randomBytes(32).toString("hex")
  const harnessId = process.env.AGENTICFORM_SOAK_HARNESS ?? "soak"
  const startedAt = new Date()
  const start = Date.now()
  const deadline = start + durationMs
  const warmupMs = Math.min(60_000, Math.max(5_000, Math.floor(durationMs / 10)))

  const hub = Bun.spawn(["bun", join(root, "packages", "hub", "bin", "hub.ts")], {
    cwd: root,
    env: {
      ...process.env,
      AGENTICFORM_ADMIN_TOKEN: adminToken,
      AGENTICFORM_HUB_PORT: "0",
      AGENTICFORM_HUB_DB: join(work, "hub.sqlite"),
      AGENTICFORM_STATE_DIR: work,
      AGENTICFORM_POLL_MS: "100",
      AGENTICFORM_HEARTBEAT_SECONDS: "5",
      AGENTICFORM_NODE_OFFLINE_SECONDS: "600",
      AGENTICFORM_LEASE_SECONDS: "60",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  let heartbeat: HeartbeatLoop | undefined
  let poller: Poller | undefined
  let executor: Executor | undefined
  const tracked: Tracked[] = []
  const samples: RssSample[] = []
  const groups = new Set<number>()
  const failures: string[] = []
  let restartsDone = 0

  try {
    const hubUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("hub did not report a URL within 15 s")), 15_000)
      let settled = false
      void (async () => {
        const decoder = new TextDecoder()
        let buffer = ""
        for await (const chunk of hub.stdout) {
          buffer += decoder.decode(chunk, { stream: true })
          if (settled) continue
          const match = /hub listening on (\S+)/.exec(buffer)
          if (match) {
            settled = true
            clearTimeout(timer)
            resolve(match[1] as string)
          }
        }
        if (!settled) {
          clearTimeout(timer)
          reject(new Error("hub exited before it reported a URL"))
        }
      })()
    })

    const headers = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }
    const api = (method: string, path: string, body?: unknown): Promise<Response> =>
      fetch(`${hubUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    const issued = (await (await api("POST", "/v1/enrollment-tokens")).json()) as { token: string }
    const keys = generateKeyPair()
    const enrolled = (await (
      await fetch(`${hubUrl}/v1/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: issued.token,
          name: "soak-node",
          publicKey: keys.publicKeyB64,
          protocolVersion: 1,
          harnesses: [harnessId],
        }),
      })
    ).json()) as { nodeId: string }
    const identity: NodeIdentity = { ...keys, nodeId: enrolled.nodeId, hubUrl }

    const config: NodeConfig = {
      hubUrl,
      stateDir,
      heartbeatIntervalMs: 2_000,
      pollMs: 100,
      leaseRenewMs: 60_000,
      requestTimeoutMs: 10_000,
      harnessProbeTtlMs: 300_000,
      harnessProbeReadyTtlMs: 3_600_000,
      harnessProbeTimeoutMs: 20_000,
      protocolVersion: 1,
    }
    const runtime =
      harnessId === "soak"
        ? (() => {
            // The workspace is bound read-write, so the fake agent lives there
            // and needs no exec bit or extra bind.
            const entry = join(work, "soak-harness.ts")
            copyFileSync(join(root, "scripts", "soak-harness.ts"), entry)
            return createRuntime({
              harnesses: {
                soak: { id: "soak", profile: "coding", command: process.execPath, args: [entry] },
              },
            })
          })()
        : createRuntime()
    const isolation = startupSelfTest()
    if (isolation.mode === "none" || isolation.selfTest !== "pass") {
      throw new Error(`the sandbox self-test did not pass: ${isolation.reason ?? isolation.selfTest}`)
    }

    const makeExecutor = (): Executor =>
      new Executor({
        isolation,
        runtime,
        harnesses: [harnessId],
        permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
        ledgerDir: join(stateDir, "ledger"),
      })
    const startNode = (): void => {
      executor = makeExecutor()
      poller = startPoller(new NodeClient(config, identity), {
        pollMs: config.pollMs,
        leaseRenewMs: config.leaseRenewMs,
        executor,
        slots: SLOTS,
      })
    }

    startNode()
    heartbeat = startHeartbeat(new NodeClient(config, identity), {
      intervalMs: config.heartbeatIntervalMs,
      body: () => ({
        protocolVersion: 1,
        status: "online",
        harnesses: [harnessId],
        capabilities: ["permissions.remote"],
        capacity: { slots: SLOTS, inUse: executor?.activeCount ?? 0 },
        runtimes: executor?.inventory() ?? [],
      }),
      onError: (error) => console.error("soak: heartbeat:", error instanceof Error ? error.message : error),
    })

    const nodeOnline = async (): Promise<boolean> => {
      const response = await api("GET", "/v1/nodes")
      if (!response.ok) return false
      const body = (await response.json()) as { nodes: { nodeId: string; status: string }[] }
      return body.nodes.some((node) => node.nodeId === enrolled.nodeId && node.status === "online")
    }
    const onlineStart = Date.now()
    while (!(await nodeOnline())) {
      if (Date.now() - onlineStart > 20_000) throw new Error("the node never came online")
      await sleep(100)
    }

    const runStatus = async (runId: string): Promise<string> => {
      const response = await api("GET", `/v1/runs/${runId}`)
      if (!response.ok) return "unknown"
      return ((await response.json()) as { status: string }).status
    }
    const waitTerminal = async (runId: string, timeoutMs: number): Promise<string> => {
      const until = Date.now() + timeoutMs
      let status = await runStatus(runId)
      while (!TERMINAL.has(status) && Date.now() < until) {
        await sleep(100)
        status = await runStatus(runId)
      }
      return status
    }
    const pendingRequest = async (runId: string, timeoutMs: number): Promise<string | null> => {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        const response = await api("GET", `/v1/runs/${runId}/permissions`)
        if (response.ok) {
          const body = (await response.json()) as { permissions: { requestId: string; status: string }[] }
          const pending = body.permissions.find((item) => item.status === "pending")
          if (pending) return pending.requestId
        }
        await sleep(50)
      }
      return null
    }

    const submit = async (kind: Kind, index: number): Promise<Tracked> => {
      const prompt = kind === "complete" ? "complete" : kind === "cancel" ? "hang" : "permission"
      const response = await api("POST", "/v1/runs", {
        idempotencyKey: `soak-${index}`,
        harness: harnessId,
        prompt,
        cwd: work,
        nodeId: enrolled.nodeId,
      })
      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`submit failed: ${response.status} ${await response.text()}`)
      }
      const { runId } = (await response.json()) as { runId: string }
      return { runId, kind, status: "queued", answered: false, unobserved: false }
    }

    const act = async (item: Tracked): Promise<void> => {
      if (item.kind === "cancel") {
        const until = Date.now() + 10_000
        while (Date.now() < until) {
          const status = await runStatus(item.runId)
          if (status === "running" || status === "leased") break
          if (TERMINAL.has(status)) return
          await sleep(50)
        }
        await api("POST", `/v1/runs/${item.runId}/cancel`)
        return
      }
      if (item.kind === "permission-allow") {
        const requestId = await pendingRequest(item.runId, 10_000)
        if (requestId === null) {
          item.unobserved = true
          await api("POST", `/v1/runs/${item.runId}/cancel`)
          return
        }
        const response = await api("POST", `/v1/runs/${item.runId}/permissions/${encodeURIComponent(requestId)}`, {
          decision: "allow",
        })
        item.answered = response.status === 200
        if (!item.answered) failures.push(`answer ${item.runId}/${requestId} returned ${response.status}`)
        return
      }
      if (item.kind === "permission-timeout") {
        const requestId = await pendingRequest(item.runId, 10_000)
        if (requestId === null) {
          item.unobserved = true
          await api("POST", `/v1/runs/${item.runId}/cancel`)
        }
      }
    }

    const restart = async (): Promise<void> => {
      const until = Date.now() + 30_000
      while ((executor?.activeCount ?? 0) > 0 && Date.now() < until) await sleep(100)
      await poller?.stop()
      await executor?.stop()
      startNode()
      restartsDone += 1
    }

    const sample = (): void => {
      const elapsedMs = Date.now() - start
      samples.push({
        at: new Date().toISOString(),
        elapsedMs,
        nodeKb: Math.round(process.memoryUsage().rss / 1024),
        hubKb: vmRssKb(hub.pid),
      })
    }

    const restartAt = (index: number): number =>
      start + Math.round((durationMs * (index + 1)) / (options.restarts + 1))
    let nextRestart = options.restarts > 0 ? restartAt(0) : Number.POSITIVE_INFINITY
    let restartIndex = 0
    let nextSample = start
    let index = 0

    // Harness children are short-lived, so the scan runs on its own clock
    // rather than once per run.
    const scanTimer = setInterval(() => {
      for (const group of childGroups(hub.pid)) groups.add(group)
    }, 200)

    sample()
    nextSample = start + 60_000
    while (Date.now() < deadline) {
      if (hub.exitCode !== null) throw new Error(`the hub exited with ${hub.exitCode}`)
      if (Date.now() >= nextRestart) {
        await restart()
        restartIndex += 1
        nextRestart = restartIndex < options.restarts ? restartAt(restartIndex) : Number.POSITIVE_INFINITY
      }
      if (Date.now() >= nextSample) {
        sample()
        nextSample += 60_000
      }
      const kind = KINDS[index % KINDS.length] as Kind
      const item = await submit(kind, index)
      index += 1
      tracked.push(item)
      await act(item)
      item.status = await waitTerminal(item.runId, 20_000)
      await sleep(GAP_MS)
    }
    clearInterval(scanTimer)

    // Let the last runs settle before counting.
    for (const item of tracked) {
      if (!TERMINAL.has(item.status)) item.status = await waitTerminal(item.runId, 60_000)
    }
    sample()

    const alive = [...groups].filter(groupAlive)
    const nonTerminal = tracked.filter((item) => !TERMINAL.has(item.status))
    const baseline = samples.find((item) => item.elapsedMs >= warmupMs) ?? samples[0]
    const final = samples.at(-1) as RssSample
    const peakKb = Math.max(...samples.map((item) => item.nodeKb))
    const growthPct = baseline && baseline.nodeKb > 0 ? ((final.nodeKb - baseline.nodeKb) / baseline.nodeKb) * 100 : 0

    if (alive.length > 0) failures.push(`orphaned process groups: ${alive.join(", ")}`)
    if (nonTerminal.length > 0) {
      failures.push(`non-terminal runs: ${nonTerminal.map((item) => `${item.runId}=${item.status}`).join(", ")}`)
    }
    if (growthPct > 20) failures.push(`final RSS is ${growthPct.toFixed(1)}% over the baseline`)

    const count = (kind: Kind): number => tracked.filter((item) => item.kind === kind).length
    const result = {
      host: hostname(),
      platform: process.platform,
      date: startedAt.toISOString(),
      bun: Bun.version,
      harness: harnessId,
      durationMs: Date.now() - start,
      restarts: restartsDone,
      runs: {
        submitted: tracked.length,
        completed: tracked.filter((item) => item.status === "completed").length,
        cancelled: tracked.filter((item) => item.status === "cancelled").length,
        failed: tracked.filter((item) => item.status === "failed").length,
        nonTerminal: nonTerminal.length,
        complete: count("complete"),
        cancel: count("cancel"),
        permissionAllow: count("permission-allow"),
        permissionTimeout: count("permission-timeout"),
        permissionAnswered: tracked.filter((item) => item.answered).length,
        permissionUnobserved: tracked.filter((item) => item.unobserved).length,
      },
      rss: {
        samples,
        baselineKb: baseline?.nodeKb ?? 0,
        peakKb,
        finalKb: final.nodeKb,
        growthPct: Number(growthPct.toFixed(1)),
      },
      orphans: { groups: groups.size, alive },
      pass: failures.length === 0,
      failures,
    }
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`)
    console.log(
      `soak: ${result.pass ? "pass" : "fail"} — ${tracked.length} runs, ${restartsDone} restarts, ` +
        `RSS ${result.rss.baselineKb}→${result.rss.finalKb} kB (${result.rss.growthPct}%), ` +
        `${alive.length} orphan groups, ${nonTerminal.length} non-terminal`,
    )
    for (const failure of failures) console.error(`soak: ${failure}`)
    return result.pass ? 0 : 1
  } finally {
    await heartbeat?.stop()
    await poller?.stop()
    await executor?.stop()
    hub.kill()
    await hub.exited
    rmSync(work, { recursive: true, force: true })
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`soak: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
