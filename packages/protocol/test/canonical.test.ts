import { describe, expect, test } from "bun:test"
import { canonicalString, commandFingerprint, sha256Hex } from "../src/canonical.ts"

describe("canonical string", () => {
  test("matches the fixed vector", () => {
    const value = canonicalString({
      nodeId: "11111111-1111-4111-8111-111111111111",
      timestampMs: 1763553600000,
      nonce: "9f2c1a7be4d80612",
      method: "post",
      path: "/v1/node/heartbeat",
      body: '{"a":1}',
    })
    expect(value).toBe(
      "11111111-1111-4111-8111-111111111111\n1763553600000\n9f2c1a7be4d80612\nPOST\n/v1/node/heartbeat\n015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    )
  })

  test("empty body hashes the empty byte array", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex(new Uint8Array())).toBe(sha256Hex(""))
  })

  test("every field changes the canonical bytes", () => {
    const base = {
      nodeId: "n",
      timestampMs: 1,
      nonce: "0123456789abcdef",
      method: "GET",
      path: "/v1/x",
      body: "",
    }
    const seen = new Set<string>()
    for (const patch of [
      {},
      { nodeId: "m" },
      { timestampMs: 2 },
      { nonce: "0123456789abcdee" },
      { method: "POST" },
      { path: "/v1/y" },
      { body: "x" },
    ]) {
      seen.add(canonicalString({ ...base, ...patch }))
    }
    expect(seen.size).toBe(7)
  })
})

describe("command fingerprint", () => {
  test("matches the fixed vector", () => {
    expect(
      commandFingerprint("run.start", "run:abc:1", 1, JSON.stringify({ generation: 1, harness: "codex", prompt: "go" })),
    ).toBe("sha256:9c62e6e00dfee86548e48d84d7bf3890b48df225bb4b31bd6117c216dee3c494")
  })

  test("field framing prevents concatenation collisions", () => {
    expect(commandFingerprint("ab", "c", 1, "{}")).not.toBe(commandFingerprint("a", "bc", 1, "{}"))
  })

  test("changes with type, key, generation and payload", () => {
    const base = commandFingerprint("run.start", "k", 1, "{}")
    expect(commandFingerprint("run.cancel", "k", 1, "{}")).not.toBe(base)
    expect(commandFingerprint("run.start", "k2", 1, "{}")).not.toBe(base)
    expect(commandFingerprint("run.start", "k", 2, "{}")).not.toBe(base)
    expect(commandFingerprint("run.start", "k", 1, '{"a":1}')).not.toBe(base)
  })
})
