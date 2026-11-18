import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// The run journey on disposable data: a real node against a fake hub and a fake
// agent, in a temporary state directory. No harness, credentials or database.
describe("clean install journey", () => {
  test("node enrolls, runs one command and completes", async () => {
    const root = join(import.meta.dir, "..", "..", "..")
    const proc = Bun.spawn(["bun", "packages/node/examples/end-to-end.ts"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(err).toBe("")
    expect(code).toBe(0)
    expect(out).toContain("message.delta")
    expect(out).toContain('completion: succeeded {"status":"completed"')
  }, 30_000)
})
