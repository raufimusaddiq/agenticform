import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { parseLabels } from "../bin/af.ts"

const bin = join(import.meta.dir, "..", "bin", "af.ts")

describe("--label parsing", () => {
  test("splits on the first '=' only", () => {
    expect(parseLabels(["k=a=b", "plain=value"])).toEqual({ k: "a=b", plain: "value" })
  })

  test("rejects a label without '='", () => {
    expect(() => parseLabels(["broken"])).toThrow('invalid --label "broken": expected key=value')
  })

  test("rejects an empty key", () => {
    expect(() => parseLabels(["=value"])).toThrow('invalid --label "=value": expected key=value')
  })

  test("a malformed label exits non-zero with a clear error", async () => {
    const result = await new Promise<{ code: number; err: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["run", bin, "run", "start", "--key", "k", "--harness", "codex", "--prompt", "p", "--label", "broken"],
        {
          env: { ...process.env, AGENTICFORM_HUB_URL: "http://127.0.0.1:1", AGENTICFORM_ADMIN_TOKEN: "x" },
          stdio: ["ignore", "ignore", "pipe"],
        },
      )
      let err = ""
      child.stderr?.on("data", (chunk) => (err += String(chunk)))
      child.on("exit", (code) => resolve({ code: code ?? -1, err }))
    })
    expect(result.code).toBe(1)
    expect(result.err).toContain('invalid --label "broken": expected key=value')
  })
})
