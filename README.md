# Agenticform

Agenticform is a Java-based control plane for orchestrating multiple Codex agent sessions across applications hosted on a server.

It is designed around these core concepts:

- **Projects** — applications/repositories registered from approved server roots.
- **Agents** — Codex sessions with explicit responsibility, role, and workspace ownership.
- **Tasks** — durable units of work assigned to coding/general agents.
- **Agent messaging** — structured communication, questions, handoffs, blockers, and reviews between agents.
- **Operational Agent** — one system-managed agent per project that owns CI/CD and operational reasoning without holding production credentials.
- **Workspaces** — isolated Git worktrees by default for coding agents, with fail-closed lifecycle cleanup.
- **Deterministic policy** — `ALLOW`, `REQUIRE_HUMAN`, or `DENY` for governed semantic actions.
- **Operational runbooks** — immutable, policy-gated execution plans for CI/CD, deploy, migration, health/readiness, backup, rollback, and other operational effects.
- **Durable external waits** — GitHub Actions work is webhook-driven and persisted instead of blocking local worker threads.
- **Two-layer queues** — Agenticform owns durable orchestration while Codex's per-thread queue is used as an execution inbox when supported.

The implementation targets a single-server deployment with a **Java 21 / Spring Boot** control plane, **PostgreSQL** persistence, a **React + TypeScript** web UI, and Codex App Server integration behind a dedicated gateway.

## Repository layout

```text
server/   Spring Boot control plane
web/      React/Vite control center
docs/     architecture and operational specifications
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
- coding worktree cleanup retention: `24h`

The UI talks only to Agenticform APIs; it never connects directly to Codex App Server.

## GitHub Actions integration

Remote-first coding/CI/CD uses:

```bash
AGENTICFORM_GITHUB_TOKEN=...
AGENTICFORM_GITHUB_WEBHOOK_SECRET=...
```

Configure a GitHub `workflow_run` webhook to:

```text
POST https://<agenticform-host>/api/webhooks/github
```

Webhook delivery is the fast path; durable GitHub API reconciliation remains the fallback when a webhook is missed.

## Design documents

- [Initial architecture](docs/architecture.md)
- [Codex queue orchestration](docs/codex-queue.md)
- [Operational contracts](docs/operations.md)
- [Durable recovery and GitHub webhooks](docs/recovery.md)
- [UI/UX specification](docs/ui-ux.md)

## Current architecture

```text
Coding / Reviewer Agent
        |
        | durable handoff
        v
Operational Agent (agentic reasoning)
        |
        | request_operation
        v
Deterministic Policy
 ALLOW / REQUIRE_HUMAN / DENY
        |
        v
Operational Runbook (deterministic effects)
        |
        +-- GitHub Actions / registry / deploy / health
        +-- durable webhook wait + reconciliation
```

Agenticform constrains side effects rather than reasoning: development agents remain free to discover, reason, modify, test, and collaborate, while production and other high-blast-radius effects pass through deterministic policy and runbook execution.
