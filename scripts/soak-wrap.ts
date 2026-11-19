#!/usr/bin/env bun
/**
 * The soak's harness wrapper (FR-018). It is the process the runtime talks to,
 * for both the fake agent and a real harness, so the spawn record has one path.
 *
 * argv: <marker> <command> [...args]
 *
 * It writes `harness/spawn-<marker>.json` with its pid/pgid as its first action,
 * before the real harness starts, then holds until the runner writes
 * `spawn-<marker>.ready`. The runner records the host process group while this
 * process is alive, which is what makes the orphan check per run.
 *
 * The real harness is spawned NOT detached, so it stays in this process group,
 * and its stdio is inherited so the ACP stream passes through unchanged.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [marker, command, ...args] = process.argv.slice(2)
if (!marker || !command) {
  console.error("soak-wrap: usage: soak-wrap <marker> <command> [...args]")
  process.exit(2)
}

const harnessDir = join(process.cwd(), "harness")
try {
  mkdirSync(harnessDir, { recursive: true })
  const pgid = (() => {
    try {
      // Inside the sandbox PID namespace, so this is only reported, never trusted.
      const stat = readFileSync("/proc/self/stat", "utf8")
      const close = stat.lastIndexOf(")")
      return Number(stat.slice(close + 2).split(" ")[2])
    } catch {
      return process.pid
    }
  })()
  writeFileSync(
    join(harnessDir, `spawn-${marker}.json`),
    JSON.stringify({ marker, pid: process.pid, pgid, at: new Date().toISOString() }),
  )
} catch {
  // No writable workspace: the runner then sees no spawn record and fails it.
}

// Hold still until the runner has recorded the host group, so a fast run cannot
// start and exit between two scans.
const release = join(harnessDir, `spawn-${marker}.ready`)
const releaseBy = Date.now() + 10_000
while (!existsSync(release) && Date.now() < releaseBy) Bun.sleepSync(5)

const child = spawn(command, args, { stdio: "inherit" })
child.on("error", (error) => {
  console.error(`soak-wrap: ${error.message}`)
  process.exit(127)
})
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
