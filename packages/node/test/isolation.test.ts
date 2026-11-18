import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRuntime, type RunEvent } from "@agenticform/runtime"
import { resolveHarness } from "../src/harness-probe.ts"
import {
  IsolationError,
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
const temp = (prefix: string, root = tempRoot): string => {
  const dir = mkdtempSync(join(root, prefix))
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

  test("a read-write state path is created 0700 and an absent read-only path is skipped", () => {
    const home = temp("af-home-")
    const profile: IsolationProfile = {
      version: 1,
      workspace: "write",
      state: [
        { path: "~/.newstate", mode: "rw" },
        { path: "~/.absent", mode: "ro" },
      ],
    }
    const args = sandboxArgs(profile, "/tmp/ws", home, {})
    const created = join(home, ".newstate")
    expect(statSync(created).mode & 0o777).toBe(0o700)
    expect(args).toContain(created)
    expect(args).not.toContain(join(home, ".absent"))
  })

  test("a profile is data: the table is the only source of binds", () => {
    const first = profileFor("claude")
    const second = profileFor("claude")
    expect(first).toEqual(second)
    expect(first.state).not.toBe(second.state)
    // A caller that mutates its copy cannot widen the table for the next run.
    first.state.push({ path: "/etc", mode: "rw" })
    expect(profileFor("claude").state).toEqual(second.state)
    // An unknown harness gets the workspace bind and no state bind. The
    // workspace is bound twice: the initial mount and the re-bind after the
    // entry-point binds.
    const args = sandboxArgs(profileFor("nope"), "/tmp/ws", "/tmp/home", {})
    const system = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc", "/run"]
    const binds = args.flatMap((arg, index) => {
      const source = args[index + 1]
      return (arg === "--bind" || arg === "--ro-bind") && source !== undefined ? [source] : []
    })
    expect(binds.filter((path) => !system.includes(path))).toEqual(["/tmp/ws", "/tmp/ws"])
  })

  test("entry-point binds come after the private tmpfs and before the root remount", () => {
    const entry = temp("af-entry-")
    const args = sandboxArgs(profileFor("nope"), "/tmp/ws", temp("af-home-"), {}, { entryDirs: [entry] })
    const tmpfs = args.indexOf("--tmpfs")
    const bind = args.indexOf(entry)
    const remount = args.indexOf("--remount-ro")
    expect(bind).toBeGreaterThan(tmpfs)
    expect(bind).toBeLessThan(remount)
    expect(args[bind - 1]).toBe("--ro-bind")
    expect(args[args.indexOf("PATH") + 1]).toContain(entry)
  })

  test("the workspace is re-bound after the entry binds", () => {
    const workspace = temp("af-ws-")
    const entry = temp("af-entry-")
    const args = sandboxArgs(profileFor("nope"), workspace, temp("af-home-"), {}, { entryDirs: [entry] })
    const entryBind = args.indexOf(entry)
    const workspaceBinds = args.flatMap((arg, index) => (arg === "--bind" && args[index + 1] === workspace ? [index] : []))
    expect(workspaceBinds).toHaveLength(2)
    expect(workspaceBinds[1]).toBeGreaterThan(entryBind)
  })

  test("an entry dir at / binds only the file, never --ro-bind / /", () => {
    const args = sandboxArgs(profileFor("nope"), "/tmp/ws", temp("af-home-"), {}, { entryDirs: ["/"] })
    const rootBinds = args.flatMap((arg, index) => (arg === "--ro-bind" && args[index + 1] === "/" ? ["/"] : []))
    expect(rootBinds).toEqual([])
  })

  test("the home root and its ancestors are not bound whole", () => {
    const home = temp("af-home-")
    for (const dir of [home, dirname(home)]) {
      const args = sandboxArgs(profileFor("nope"), "/tmp/ws", home, {}, { entryDirs: [dir] })
      const binds = args.flatMap((arg, index) => (arg === "--ro-bind" && args[index + 1] === dir ? [dir] : []))
      expect(binds).toEqual([])
    }
  })

  test("an entry dir inside the workspace is not bound read-only", () => {
    const workspace = temp("af-ws-")
    const entry = join(workspace, "bin")
    mkdirSync(entry)
    const args = sandboxArgs(profileFor("nope"), workspace, temp("af-home-"), {}, { entryDirs: [entry] })
    const binds = args.flatMap((arg, index) => (arg === "--ro-bind" && args[index + 1] === entry ? [entry] : []))
    expect(binds).toEqual([])
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

  test("an entry dir that is an ancestor of the workspace keeps the workspace writable", async () => {
    const entryDir = "/var/tmp"
    const entry = join(entryDir, `af-entry-${randomUUID()}.ts`)
    writeFileSync(entry, `#!/usr/bin/env bun\n${readFileSync(fakeHarness, "utf8")}`, { mode: 0o755 })
    try {
      const workspace = temp("af-ws-")
      // Keep the home off /var/tmp: the entry dir is /var/tmp, and an entry dir
      // that is an ancestor of the home is refused (BLOCKER 2).
      const home = temp("af-home-", "/tmp")
      const resolved = resolveWorkspace(workspace, home)
      const inside = join(workspace, "inside.txt")
      const resolution = resolveHarness({
        id: "fake",
        profile: "coding",
        command: entry,
        args: [JSON.stringify({ scenario: "writes", writes: [inside] })],
      })
      if (!resolution.ok) throw new Error("entry did not resolve")
      const definition = sandboxHarness(
        resolution.resolved.definition,
        profileFor("fake"),
        resolved,
        home,
        process.env,
        { entryDirs: resolution.resolved.dirs, entryFiles: resolution.resolved.files },
      )
      const run = createRuntime().run({ harness: definition, cwd: resolved, prompt: "go" })
      const result = await run.result()
      expect(result.text).toBe(`${inside}=ok`)
    } finally {
      rmSync(entry, { force: true })
    }
  })

  test("a harness inside a state dir is reached through the state bind", async () => {
    const home = temp("af-home-")
    const stateDir = join(home, ".claude")
    mkdirSync(join(stateDir, "local"), { recursive: true })
    const entry = join(stateDir, "local", "claude.ts")
    writeFileSync(entry, `#!/usr/bin/env bun\n${readFileSync(fakeHarness, "utf8")}`, { mode: 0o755 })
    const workspace = temp("af-ws-")
    const resolved = resolveWorkspace(workspace, home)
    const inside = join(workspace, "inside.txt")
    const resolution = resolveHarness({
      id: "claude",
      profile: "coding",
      command: entry,
      args: [JSON.stringify({ scenario: "writes", writes: [inside] })],
    })
    if (!resolution.ok) throw new Error("entry did not resolve")
    const definition = sandboxHarness(
      resolution.resolved.definition,
      profileFor("claude"),
      resolved,
      home,
      process.env,
      { entryDirs: resolution.resolved.dirs, entryFiles: resolution.resolved.files },
    )
    expect(definition.args).toContain("/home/agent/.claude/local/claude.ts")
    const run = createRuntime().run({ harness: definition, cwd: resolved, prompt: "go" })
    const result = await run.result()
    expect(result.text).toBe(`${inside}=ok`)
  })

  for (const protectedDir of ["~/.local", "~/.config"]) {
    test(`${protectedDir} is not bound whole and its siblings stay invisible`, async () => {
      const home = temp("af-home-")
      const dir = join(home, protectedDir.slice(2))
      mkdirSync(dir, { recursive: true })
      const entry = join(dir, "agent.ts")
      writeFileSync(entry, `#!/usr/bin/env bun\n${readFileSync(fakeHarness, "utf8")}`, { mode: 0o755 })
      const sibling =
        protectedDir === "~/.local" ? join(home, ".local", "share", "keyrings") : join(home, ".config", "gh")
      mkdirSync(sibling, { recursive: true })
      writeFileSync(join(sibling, "secret"), "secret")
      const workspace = temp("af-ws-")
      const resolved = resolveWorkspace(workspace, home)
      const resolution = resolveHarness({
        id: "fake",
        profile: "coding",
        command: entry,
        args: [JSON.stringify({ scenario: "writes", reads: [join(sibling, "secret")] })],
      })
      if (!resolution.ok) throw new Error("entry did not resolve")
      const definition = sandboxHarness(
        resolution.resolved.definition,
        profileFor("fake"),
        resolved,
        home,
        process.env,
        { entryDirs: resolution.resolved.dirs, entryFiles: resolution.resolved.files },
      )
      const run = createRuntime().run({ harness: definition, cwd: resolved, prompt: "go" })
      const result = await run.result()
      expect(result.status).toBe("completed")
      expect(result.text).toBe(`read:${join(sibling, "secret")}=ENOENT`)
    })
  }

  for (const root of ["/tmp", "/var/tmp"]) {
    test(`a sibling in ${root} is not visible when the entry is directly in ${root}`, async () => {
      const entry = join(root, `af-entry-${randomUUID()}.ts`)
      const sibling = join(root, `af-sibling-${randomUUID()}`)
      writeFileSync(entry, `#!/usr/bin/env bun\n${readFileSync(fakeHarness, "utf8")}`, { mode: 0o755 })
      writeFileSync(sibling, "secret")
      try {
        const workspace = temp("af-ws-")
        // Keep the home off the entry's temp root so the home guard does not
        // refuse the entry dir before the file-only bind is exercised.
        const home = temp("af-home-", root === "/tmp" ? "/var/tmp" : "/tmp")
        const resolved = resolveWorkspace(workspace, home)
        const resolution = resolveHarness({
          id: "fake",
          profile: "coding",
          command: entry,
          args: [JSON.stringify({ scenario: "writes", reads: [sibling] })],
        })
        if (!resolution.ok) throw new Error("entry did not resolve")
        const definition = sandboxHarness(
          resolution.resolved.definition,
          profileFor("fake"),
          resolved,
          home,
          process.env,
          { entryDirs: resolution.resolved.dirs, entryFiles: resolution.resolved.files },
        )
        const run = createRuntime().run({ harness: definition, cwd: resolved, prompt: "go" })
        const result = await run.result()
        expect(result.status).toBe("completed")
        expect(result.text).toBe(`read:${sibling}=ENOENT`)
      } finally {
        rmSync(entry, { force: true })
        rmSync(sibling, { force: true })
      }
    })
  }

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

  test("claude: ~/.claude is writable and undeclared home paths are absent", async () => {
    const home = temp("af-home-")
    mkdirSync(join(home, ".claude"))
    mkdirSync(join(home, ".config", "claude"), { recursive: true })
    mkdirSync(join(home, ".ssh"))
    writeFileSync(join(home, ".ssh", "id_ed25519"), "secret")
    const workspace = temp("af-ws-")
    const { result } = await runFake(
      "claude",
      {
        scenario: "writes",
        writes: ["/home/agent/.claude/session.json", "/home/agent/.config/claude/settings.json"],
        reads: ["/home/agent/.ssh/id_ed25519", "/home/agent/.ssh"],
      },
      { workspace, home },
    )
    expect(result.text).toBe(
      [
        "/home/agent/.claude/session.json=ok",
        "/home/agent/.config/claude/settings.json=ENOENT",
        "read:/home/agent/.ssh/id_ed25519=ENOENT",
        "read:/home/agent/.ssh=ENOENT",
      ].join("\n"),
    )
  })

  test("opencode: the data dir is writable and the config dir is read-only", async () => {
    const home = temp("af-home-")
    mkdirSync(join(home, ".local", "share", "opencode", "log"), { recursive: true })
    mkdirSync(join(home, ".config", "opencode"), { recursive: true })
    const workspace = temp("af-ws-")
    const { result } = await runFake(
      "opencode",
      {
        scenario: "writes",
        writes: ["/home/agent/.local/share/opencode/log/run.log", "/home/agent/.config/opencode/opencode.jsonc"],
      },
      { workspace, home },
    )
    expect(result.text).toBe(
      [
        "/home/agent/.local/share/opencode/log/run.log=ok",
        "/home/agent/.config/opencode/opencode.jsonc=EROFS",
      ].join("\n"),
    )
  })

  test("an unknown harness sees only the workspace and an empty home", async () => {
    const home = temp("af-home-")
    mkdirSync(join(home, ".ssh"))
    mkdirSync(join(home, ".claude"))
    const workspace = temp("af-ws-")
    const { result } = await runFake(
      "nope",
      {
        scenario: "list",
        lists: ["/home/agent", "/home/agent/.ssh", "/home/agent/.claude"],
      },
      { workspace, home },
    )
    expect(result.text).toBe(
      ["list:/home/agent=", "list:/home/agent/.ssh=ENOENT", "list:/home/agent/.claude=ENOENT"].join("\n"),
    )
  })

  test("no AGENTICFORM_* variable or node secret reaches the harness", async () => {
    const saved = { ...process.env }
    process.env.AGENTICFORM_ADMIN_TOKEN = "admin-secret"
    process.env.AGENTICFORM_ENROLLMENT_TOKEN = "enroll-secret"
    process.env.AGENTICFORM_HUB_URL = "https://hub.example"
    process.env.NODE_SECRET = "node-secret"
    try {
      const { result } = await runFake("claude", { scenario: "env" })
      expect(result.text).not.toContain("AGENTICFORM_")
      expect(result.text).not.toContain("admin-secret")
      expect(result.text).not.toContain("enroll-secret")
      expect(result.text).not.toContain("node-secret")
      expect(result.text).toContain("HOME=/home/agent")
      expect(result.text).toContain("/usr/local/bin:/usr/bin:/bin")
    } finally {
      for (const name of ["AGENTICFORM_ADMIN_TOKEN", "AGENTICFORM_ENROLLMENT_TOKEN", "AGENTICFORM_HUB_URL", "NODE_SECRET"]) {
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
      }
    }
  })
})
