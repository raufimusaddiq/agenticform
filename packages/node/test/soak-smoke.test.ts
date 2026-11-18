import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// T037: the 2-minute smoke mode of scripts/soak.ts. The node refuses every run
// without a sandbox, so the soak needs bwrap. It skips on a host without it and
// fails under CI, where a missing sandbox is a broken runner rather than a
// local choice (T046).
const hasBwrap = Bun.spawnSync(["sh", "-c", "command -v bwrap"]).exitCode === 0
if (!hasBwrap) {
  if (process.env.CI) {
    test("soak smoke requires bwrap in CI", () => {
      throw new Error("bwrap is not installed; the soak smoke cannot run in CI")
    })
  } else {
    console.log("soak smoke skipped: bwrap is not installed")
  }
}

/** Kill the soak and everything it started, including the hub and bwrap. */
function killTree(proc: Bun.Subprocess): void {
  if (proc.exitCode !== null) return
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"])
    return
  }
  try {
    process.kill(-proc.pid, "SIGKILL")
  } catch {
    proc.kill(9)
  }
}

describe.skipIf(!hasBwrap)("soak smoke (T037)", () => {
  test("a 2-minute soak passes with allow and timeout through the hub", async () => {
    const root = join(import.meta.dir, "..", "..", "..")
    const dir = mkdtempSync(join(tmpdir(), "af-soak-smoke-"))
    const out = join(dir, "soak-result.json")
    const proc = Bun.spawn(
      ["bun", "scripts/soak.ts", "--minutes", "2", "--restarts", "1", "--settle-ms", "15000", "--out", out],
      { cwd: root, stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" },
    )
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) console.error(stdout, stderr)
      expect(code).toBe(0)

      const result = JSON.parse(readFileSync(out, "utf8")) as {
        pass: boolean
        restarts: number
        runs: {
          submitted: number
          permissionAllow: number
          permissionTimeout: number
          permissionAnswered: number
          permissionUnobserved: number
          nonTerminal: number
        }
        orphans: { groups: number; alive: number[] }
      }
      expect(result.pass).toBe(true)
      expect(result.restarts).toBe(1)
      expect(result.runs.submitted).toBeGreaterThan(0)
      expect(result.runs.permissionAllow).toBeGreaterThan(0)
      expect(result.runs.permissionTimeout).toBeGreaterThan(0)
      expect(result.runs.permissionAnswered).toBeGreaterThan(0)
      expect(result.runs.permissionUnobserved).toBe(0)
      expect(result.runs.nonTerminal).toBe(0)
      expect(result.orphans.groups).toBeGreaterThan(0)
      expect(result.orphans.alive).toEqual([])
    } finally {
      killTree(proc)
      await Promise.race([proc.exited, Bun.sleep(5_000)])
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
