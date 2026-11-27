import type { HarnessDefinition } from "./types.ts"

/**
 * Known entry points. `documented` means taken from upstream documentation or packages,
 * not proven by the conformance suite. See docs/harnesses.md.
 */
export const harnesses: Readonly<Record<string, HarnessDefinition>> = {
  claude: {
    id: "claude",
    profile: "coding",
    command: "bunx",
    args: ["@agentclientprotocol/claude-agent-acp@0.113.0"],
    verification: "documented",
    // claude-agent-acp completes the handshake logged out, so ask the CLI it bundles.
    authCheck: {
      bin: [
        "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
        "@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
      ],
      args: ["auth", "status"],
      loggedIn: "loggedIn",
    },
  },
  codex: {
    id: "codex",
    profile: "coding",
    command: "bunx",
    args: ["@agentclientprotocol/codex-acp@2.12.1"],
    verification: "documented",
  },
  opencode: {
    id: "opencode",
    profile: "coding",
    command: "opencode",
    args: ["acp"],
    verification: "tested",
    notes: "Tested with opencode 2.3.2.",
  },
  omp: { id: "omp", profile: "coding", command: "omp", args: ["acp"], verification: "documented" },
  pi: {
    id: "pi",
    profile: "coding",
    command: "bunx",
    args: ["pi-acp@0.0.35"],
    verification: "documented",
    notes: "Early third-party adapter.",
  },
  dsh: {
    id: "dsh",
    profile: "coding",
    command: "dsh",
    args: ["--profile", "acp"],
    verification: "documented",
    notes: "Developer preview upstream; pin the installed version.",
  },
  hermes: {
    id: "hermes",
    profile: "agentic",
    command: "hermes",
    args: ["acp"],
    verification: "documented",
    notes: "Requires the Hermes ACP extra.",
  },
  openclaw: {
    id: "openclaw",
    profile: "agentic",
    command: "openclaw",
    args: ["acp"],
    verification: "documented",
    notes: "Gateway-backed bridge; workspace and sandbox guarantees differ.",
  },
}
