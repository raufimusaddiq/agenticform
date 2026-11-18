import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRuntime, type RunEvent } from "@agenticform/runtime"
import {
  profileFor,
  resolveWorkspace,
  sandboxArgs,
  sandboxHarness,
  selfTest,
  type IsolationProfile,
  type WorkspaceMode,
} from "../src/isolation.ts"

const bunDir = dirname(process.execPath)
const fakeHarness = join(import.meta.dir, "fake-harness.ts")
const hasBwrap = Bun.spawnSync(["sh", "-c", "command -v bwrap"]).exitCode === 0

/**
 * Temp dirs live outside /tmp: /tmp is a private tmpfs inside the sandbox, so a
 * sibling there would be writable by design. /var/tmp is in the read-only root.
 */
const tempRoot = Bun.spawnSync(["sh", "-c", "test -w /var/tmp"]).exitCode === 0 ? "/var/tmp" : tmpdir()
const tempDirs: string[] = []
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tempRoot, prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The catalog profile plus the interpreter and test dir the fake child needs. */
const testProfile = (harness: string, mode: WorkspaceMode = "write"): IsolationProfile => {
  const profile = profileFor(harness, mode)
  profile.state.push({ path: bunDir, mode: "ro" }, { path: import.meta.dir, mode: "ro" })
  return profile
}

const collect = async (events: AsyncIterable<RunEvent>): Promise<RunEvent[]> => {
  const seen: RunEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

const runFake = async (
  harness: string,
  spec: object,
  options: { workspace?: string; home?: string; mode?: WorkspaceMode } = {},
) => {
  const workspace = options.workspace ?? temp("af-ws-")
  const home = options.home ?? temp("af-home-")
  const resolved = resolveWorkspace(workspace, home)
  const definition = sandboxHarness(
    { id: harness, profile: "coding", command: process.execPath, args: [fakeHarness, JSON.stringify(spec)] },
    testProfile(harness, options.mode ?? "write"),
    resolved,
    home,
  )
  const run = createRuntime().run({ harness: definition, cwd: resolved, prompt: "go" })
  const events = await collect(run.events())
  const result = await run.result()
  return { result, events, workspace, home }
}

const alive = (marker: string): boolean => Bun.spawnSync(["pgrep", "-f", marker]).exitCode === 0

describe("isolation argv", () => {
  test("follows the fixed order and clears the environment", () => {
    const home = temp("af-home-")
    const args = sandboxArgs(profileFor("claude"), "/tmp/ws", home, {
      TERM: "xterm",
      AGENTICFORM_ADMIN_TOKEN: "secret",
    })
    expect(args.slice(0, 5)).toEqual([
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
    ])
    expect(args).not.toContain("--unshare-net")
    expect(args).toContain("--clearenv")
    expect(args).toContain("--die-with-parent")
    expect(args).toContain("--new-session")
    expect(args).not.toContain("AGENTICFORM_ADMIN_TOKEN")
    expect(args).not.toContain("secret")
    expect(args).toContain("TERM")
    expect(args.indexOf("--clearenv")).toBeLessThan(args.indexOf("--setenv"))
    expect(args.indexOf("--proc")).toBeLessThan(args.indexOf("--tmpfs"))
    expect(args.indexOf("--tmpfs")).toBeLessThan(args.indexOf("--bind"))
    expect(args.at(-2)).toBe("--remount-ro")
  })

  test("an unknown harness gets an empty profile", () => {
    expect(profileFor("nope").state).toEqual([])
    expect(profileFor("claude").state.length).toBeGreaterThan(0)
  })

  test("the workspace is resolved and / and the home root are refused", () => {
    const home = temp("af-home-")
    const target = temp("af-target-")
    const link = join(temp("af-link-"), "link")
    symlinkSync(target, link)
    expect(resolveWorkspace(link, home)).toBe(target)
    expect(() => resolveWorkspace("/", home)).toThrow()
    expect(() => resolveWorkspace(home, home)).toThrow()
    expect(() => resolveWorkspace(join(home, "absent"), home)).toThrow()
  })
})

describe.skipIf(!hasBwrap && !process.env.CI)("isolation: real bwrap", () => {
  test("bwrap is available", () => {
    expect(hasBwrap).toBe(true)
  })

  test("the self-test proves the write boundary", () => {
    expect(selfTest()).toEqual({ mode: "bwrap", selfTest: "pass" })
  })

  test("the self-test catches a missing root remount", () => {
    expect(selfTest({ remountRoot: false })).toEqual({
      mode: "none",
      selfTest: "fail",
      reason: "write_not_denied",
    })
  })

  for (const harness of createRuntime().harnesses().map((entry) => entry.id)) {
    test(`${harness}: a write inside the workspace succeeds and outside writes fail`, async () => {
      const root = temp("af-root-")
      const workspace = join(root, "ws")
      const sibling = join(root, "sibling")
      mkdirSync(workspace)
      mkdirSync(sibling)
      const home = temp("af-home-")
      const inside = join(workspace, "inside.txt")
      const outsideHome = join(home, "outside.txt")
      const outsideSibling = join(sibling, "outside.txt")
      const outsideParent = join(root, "outside.txt")
      const { result } = await runFake(
        harness,
        { scenario: "writes", writes: [inside, outsideHome, outsideSibling, outsideParent, "/usr/af-denied"] },
        { workspace, home },
      )
      expect(result.status).toBe("completed")
      const lines = result.text.split("\n")
      expect(lines[0]).toBe(`${inside}=ok`)
      expect(lines[1]).toMatch(/=(ENOENT|EROFS)$/)
      expect(lines[2]).toMatch(/=(ENOENT|EROFS)$/)
      expect(lines[3]).toBe(`${outsideParent}=EROFS`)
      expect(lines[4]).toBe("/usr/af-denied=EROFS")
    })
  }

  test("a read-only run cannot write inside the workspace", async () => {
    const workspace = temp("af-ws-")
    const home = temp("af-home-")
    const inside = join(workspace, "inside.txt")
    const { result } = await runFake(
      "claude",
      { scenario: "writes", writes: [inside] },
      { workspace, home, mode: "read-only" },
    )
    expect(result.text).toBe(`${inside}=EROFS`)
  })

  test("a symlinked workspace binds its target and the target's parent stays read-only", async () => {
    const root = temp("af-link-")
    const target = join(root, "target")
    mkdirSync(target)
    const link = join(root, "link")
    symlinkSync(target, link)
    const home = temp("af-home-")
    const inside = join(target, "inside.txt")
    const parent = join(root, "outside.txt")
    const { result } = await runFake("claude", { scenario: "writes", writes: [inside, parent] }, { workspace: link, home })
    const lines = result.text.split("\n")
    expect(lines[0]).toBe(`${inside}=ok`)
    expect(lines[1]).toBe(`${parent}=EROFS`)
  })

  test("each run gets a private /tmp and home", async () => {
    const workspace = temp("af-ws-")
    const home = temp("af-home-")
    const first = await runFake(
      "claude",
      { scenario: "writes", writes: ["/tmp/af-private.txt", "/home/agent/af-private.txt"] },
      { workspace, home },
    )
    expect(first.result.text).toBe("/tmp/af-private.txt=ok\n/home/agent/af-private.txt=ok")
    const second = await runFake(
      "claude",
      { scenario: "writes", reads: ["/tmp/af-private.txt", "/home/agent/af-private.txt"] },
      { workspace, home },
    )
    expect(second.result.text).toBe("read:/tmp/af-private.txt=ENOENT\nread:/home/agent/af-private.txt=ENOENT")
  })

  test("the harness is a separate child in its own process group and cancel stops the group", async () => {
    const workspace = temp("af-ws-")
    const home = temp("af-home-")
    const marker = `af-child-${randomUUID()}`
    const resolved = resolveWorkspace(workspace, home)
    const definition = sandboxHarness(
      {
        id: "claude",
        profile: "coding",
        command: process.execPath,
        args: [fakeHarness, JSON.stringify({ scenario: "child", marker })],
      },
      testProfile("claude"),
      resolved,
      home,
    )
    const run = createRuntime().run({ harness: definition, cwd: resolved, prompt: "go" })
    let seen = ""
    for await (const event of run.events()) {
      if (event.type === "message.delta") seen += event.text
      if (seen.includes(marker)) break
    }
    expect(seen).toContain(marker)
    expect(alive(marker)).toBe(true)
    await run.cancel()
    await run.result()
    await Bun.sleep(200)
    expect(alive(marker)).toBe(false)
  })
})
