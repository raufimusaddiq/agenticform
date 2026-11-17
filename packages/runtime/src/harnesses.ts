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
    args: ["@agentclientprotocol/claude-agent-acp@0.100.0"],
    verification: "documented",
  },
  codex: {
    id: "codex",
    profile: "coding",
    command: "bunx",
    args: ["@agentclientprotocol/codex-acp@2.5.0"],
    verification: "documented",
  },
  opencode: { id: "opencode", profile: "coding", command: "opencode", args: ["acp"], verification: "documented" },
  omp: { id: "omp", profile: "coding", command: "omp", args: ["acp"], verification: "documented" },
  pi: {
    id: "pi",
    profile: "coding",
    command: "bunx",
    args: ["pi-acp@0.0.34"],
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
