import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// T037: the 2-minute smoke mode of scripts/soak.ts. The node refuses every run
// without a sandbox, so the soak needs bwrap. It skips on a host without it and
// fails under CI, where a missing sandbox is a broken runner rather than a
// local choice (T046).
const hasBwrap = Bun.spawnSync(["sh", "-c", "command -v bwrap"]).exitCode === 0
if (!hasBwrap) console.log("soak smoke skipped: bwrap is not installed")

describe.skipIf(!hasBwrap)("soak smoke (T037)", () => {
  test("a 2-minute soak passes with allow and timeout through the hub", async () => {
    const root = join(import.meta.dir, "..", "..", "..")
    const out = join(mkdtempSync(join(tmpdir(), "af-soak-smoke-")), "soak-result.json")
    const proc = Bun.spawn(
      ["bun", "scripts/soak.ts", "--minutes", "2", "--restarts", "1", "--out", out],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
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
        nonTerminal: number
      }
      orphans: { alive: number[] }
    }
    expect(result.pass).toBe(true)
    expect(result.restarts).toBe(1)
    expect(result.runs.submitted).toBeGreaterThan(0)
    expect(result.runs.permissionAllow).toBeGreaterThan(0)
    expect(result.runs.permissionTimeout).toBeGreaterThan(0)
    expect(result.runs.permissionAnswered).toBeGreaterThan(0)
    expect(result.runs.nonTerminal).toBe(0)
    expect(result.orphans.alive).toEqual([])
  }, 180_000)
})
