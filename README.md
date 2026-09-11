# Agenticform

Agenticform is a Java-based control plane for orchestrating multiple Codex agent sessions across applications hosted on a server.

It is designed around these core concepts:

- **Projects** — applications/repositories registered from approved server roots.
- **Agents** — Codex sessions with explicit responsibility, capability, and workspace ownership.
- **Tasks** — durable units of work assigned to agents.
- **Agent messaging** — structured communication, questions, handoffs, blockers, and reviews between agents.
- **Workspaces** — isolated Git worktrees by default for agents that modify code.
- **Approvals** — explicit gates for sensitive actions such as merge, deploy, destructive operations, and cross-project writes.
- **Two-layer queues** — Agenticform owns durable task orchestration while Codex's per-thread queue is used as an execution inbox when supported.

The initial design targets a single-server deployment with a **Java / Spring Boot** control plane, **PostgreSQL** persistence, a web UI, and Codex integration behind a dedicated gateway.

## Design documents

- [Initial architecture](docs/architecture.md)
- [Codex queue orchestration](docs/codex-queue.md)
- [UI/UX specification](docs/ui-ux.md)

The UI specification borrows relevant anti-slop and design-discipline principles from [`Leonxlnx/taste-skill`](https://github.com/Leonxlnx/taste-skill), while adapting them for Agenticform's dense developer-tool/dashboard use case.

## Status

Architecture/design phase. The queue design intentionally treats Codex's current thread queue APIs as an experimental integration capability rather than Agenticform's domain source of truth.
