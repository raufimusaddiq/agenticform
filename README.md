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

The implementation targets a single-server deployment with a **Java 21 / Spring Boot** control plane, **PostgreSQL** persistence, a **React + TypeScript** web UI, and Codex App Server integration behind a dedicated gateway.

## Repository layout

```text
server/   Spring Boot control plane
web/      React/Vite control center
docs/     architecture and UI specifications
```

## Local development

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Start Codex App Server separately on the configured WebSocket endpoint (default `ws://127.0.0.1:4500`).

Run the backend:

```bash
cd server
mvn spring-boot:run
```

Run the UI in a second terminal:

```bash
cd web
npm install
npm run dev
```

Defaults:

- API: `http://localhost:8080`
- UI: `http://localhost:5173`
- PostgreSQL: `localhost:5432/agenticform`
- allowed project root: `/srv/apps`
- worktree root: `/srv/agenticform/worktrees`

The UI talks only to Agenticform APIs; it never connects directly to Codex App Server.

## Design documents

- [Initial architecture](docs/architecture.md)
- [Codex queue orchestration](docs/codex-queue.md)
- [UI/UX specification](docs/ui-ux.md)

The UI specification borrows relevant anti-slop and design-discipline principles from [`Leonxlnx/taste-skill`](https://github.com/Leonxlnx/taste-skill), while adapting them for Agenticform's dense developer-tool/dashboard use case.

## Implementation status

Phase 1 foundation is in progress: project registration, isolated workspaces, Codex thread creation, durable task dispatch, queue reconciliation, and the first control-center UI.
