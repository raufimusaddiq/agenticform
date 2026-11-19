# Research: Runtime Foundation

Checked on 2026-11-05. Support below is documentation-based unless marked otherwise; no real harness has passed the suite yet.

| Harness | Entry point | Source | Profile |
|---|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` 0.100.0 | npm | coding |
| Codex | `@agentclientprotocol/codex-acp` 2.5.0 | npm | coding |
| OpenCode | `opencode acp` | opencode.ai/docs/acp | coding |
| omp | `omp acp` | block/buzz PR #2573; verify on installed version | coding |
| Pi | `pi-acp` 0.0.34 | npm; `pi --mode rpc` is a fallback | coding |
| DeepSeek Harness | `dsh --profile acp` | apps/cli/README.md, developer preview | coding |
| Hermes | `hermes acp` | hermes-agent docs, needs ACP extra | agentic |
| OpenClaw | `openclaw acp` | docs.openclaw.ai, gateway bridge with partial features | agentic |

## Decisions

- **Driver**: official `@agentclientprotocol/sdk` 2.4.0, stable v1 entrypoint. Rationale: v2 is draft and changes prompt semantics. Alternative: `@ai-sdk/harness-acp`, rejected because it is experimental and brings its own sandbox abstraction.
- **Client capabilities**: advertise no `fs` or `terminal`. Harnesses use their own tools, which keeps the runtime small and leaves isolation to the node layer.
- **Authentication**: treat `auth_required` as a terminal error. Rationale: credentials belong to the harness owner.
- **Steer**: cancel followed by a new prompt in the same session, marked emulated.
- **Process spawning**: `node:child_process`, so the package also works on Node.
- **Comparison input**: T3 Code uses direct drivers for its richest harness features and ACP for others. Agenticform does not need steering, forking or rollback fidelity at this stage, so ACP stays the only driver.

## Amendment (2026-11-19): permission policy defaults to allow

Constitution 2.0.0 changes principle IV: the run's permission policy decides, and the default is `allow`, because the sandbox is the boundary (writes only inside the workspace and declared state dirs, private /tmp and home, cleared env), the same way a rig worktree bounds rig's own agents. A run opts out with `ask` (owner answer, deny at the timeout) or `deny`. Harness-native auto or bypass permission modes, such as claude-agent-acp's auto mode from 0.101, are consistent with the `allow` default, because the sandbox is the boundary. Only one-time grants are still ever selected, and a missing sandbox still fails the run.
