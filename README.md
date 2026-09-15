# Agenticform

Agenticform is a Java-based control plane for orchestrating multiple Codex agents across local and enrolled execution nodes.

It is designed around these core concepts:

- **Projects** — local applications or GIT-backed repositories registered with the control plane.
- **Agents** — Codex sessions with explicit responsibility, role, workspace ownership, and optional execution-node placement.
- **Tasks** — durable units of work assigned to coding/general agents.
- **Agent communication fabric** — durable direct, multicast, role, group, and project-broadcast communication with per-recipient delivery state.
- **Orchestrator** — one system-managed agent per project that owns the human-facing task pipe, delegation, and consolidated reports.
- **Operational Agent** — one system-managed agent per project that owns CI/CD and operational reasoning without holding production credentials.
- **Execution nodes** — outbound-only workers enrolled with one-time tokens and long-lived Ed25519 device identities.
- **Runtime generation fencing** — remote agent runtimes are versioned so a stale/reconnected node cannot mutate a newer replacement runtime.
- **Durable node effects** — node commands use an effectively-once execution ledger and fail closed when a prior side effect is ambiguous.
- **Durable remote approvals** — human approvals survive control-plane/node restarts without keeping one HTTP request open.
- **Workspaces** — isolated Git worktrees by default for coding agents, with fail-closed local and distributed lifecycle cleanup.
- **Deterministic policy** — `ALLOW`, `REQUIRE_HUMAN`, or `DENY` for governed semantic actions.
- **Operational runbooks** — immutable, policy-gated execution plans for CI/CD, deploy, migration, health/readiness, backup, rollback, and other operational effects.
- **Durable external waits** — GitHub Actions work is webhook-driven and persisted instead of blocking local worker threads.
- **Two-layer queues** — Agenticform owns durable orchestration while Codex's per-thread queue is used as an execution inbox when supported.

The control plane uses **Java 21 / Spring Boot**, **PostgreSQL**, and a **React + TypeScript** web UI. Execution nodes use a small **Go** daemon and run Codex App Server locally over stdio; they do not expose Codex on the network.

## Repository layout

```text
server/   Spring Boot control plane
web/      React/Vite control center
node/     Go execution-node daemon and container
docs/     architecture, security, recovery, and operational specifications
```

## Local development

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Generate an admin token of at least 32 characters, for example:

```bash
export AGENTICFORM_ADMIN_TOKEN="$(openssl rand -hex 32)"
```

Start Codex App Server separately on the configured WebSocket endpoint for local/control-plane agents (default `ws://127.0.0.1:4500`).

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
- allowed local project root: `/srv/apps`
- worktree root: `/srv/agenticform/worktrees`
- coding worktree cleanup retention: `24h`

The UI asks for `AGENTICFORM_ADMIN_TOKEN` and retains it only in browser `sessionStorage`. It talks only to Agenticform APIs; it never connects directly to Codex App Server.

## Self-Hosted Alpha

Published-image installation uses the root `docker-compose.yml` and `.env.example`:

```bash
cp .env.example .env
# Set AGENTICFORM_ADMIN_TOKEN and POSTGRES_PASSWORD in .env.
docker compose pull
docker compose up -d
```

Open the configured public URL, sign in with the single-owner admin token, register a project, then enroll a node from **Execution nodes**. Public deployments require HTTPS and an immutable `AGENTICFORM_NODE_IMAGE` digest. See [Self-Hosted Alpha](docs/self-hosted-alpha.md) for update, backup/restore, proxy, networking, and runtime-readiness guidance.

## Distributed execution nodes

Open **Execution nodes** in the authenticated UI, choose a node name/trust level, and generate the single-use setup command. Run that command as a non-root user on the target server or workstation.

The setup flow:

```text
one-time enrollment token
        ↓
node-local Ed25519 key generation
        ↓
secure enrollment
        ↓
bootstrap token consumed
        ↓
permanent outbound-only daemon
        ↓
Codex App Server over local stdio
```

No inbound worker port, public Codex endpoint, SSH connectivity from Agenticform, or shared long-lived node secret is required.

For remote/non-loopback deployments configure at least:

```bash
AGENTICFORM_PUBLIC_URL=https://agenticform.example.com
AGENTICFORM_ADMIN_TOKEN=<random value at least 32 characters>
AGENTICFORM_SECRET_KEY=<random value at least 32 characters; recommended for encrypted project credentials>
AGENTICFORM_NODE_IMAGE=ghcr.io/raufimusaddiq/agenticform-node@sha256:<published digest>
```

Remote control planes fail closed if HTTPS, admin authentication, or immutable node-image requirements are not satisfied.

See [Distributed Agent Fabric](docs/distributed-agent-fabric.md) for enrollment, trust, replay protection, runtime isolation, revocation, and compromise-containment details.

## Distributed runtime recovery

Remote agents are bound to a monotonically increasing runtime generation and opaque runtime identity. Commands, Codex events, approvals, Git credentials, and runtime snapshots are accepted only for the current `(node, generation, runtimeType, runtimeSessionId)` identity.

Node command transport is intentionally at-least-once, while node effects are fenced by a persistent local execution ledger. A duplicate terminal command returns its cached result. A command left in `STARTED` after a crash is treated as ambiguous and is **not** replayed automatically.

Execution-node heartbeat includes persisted runtime inventory. A restarted node can therefore reconcile an existing current Codex runtime instead of creating another thread.

If a node is lost long enough, eligible GIT-backed agents can be rehydrated onto another node:

```bash
AGENTICFORM_NODE_RECOVERY_GRACE=2m
AGENTICFORM_NODE_AUTO_RECOVERY=true
```

Rehydration creates a new runtime generation and recovery branch. It restores logical/durable Agenticform state and may re-dispatch the active durable task. It does **not** live-migrate a process or recover local-only uncommitted files from a permanently dead node.

See [Durable Recovery](docs/recovery.md) for restart, node-loss, approval, cleanup, and fail-closed semantics.

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

### Private GitHub repositories on execution nodes

For private repository materialization, prefer the GitHub App credential broker. Alternatively, register one repository-scoped GitHub token in the web UI. The token is encrypted in the control plane and delivered to each enrolled node only as an RSA-encrypted, short-lived credential response; it is not persisted on nodes.

```bash
AGENTICFORM_GITHUB_APP_ID=<app-id>
AGENTICFORM_GITHUB_INSTALLATION_ID=<installation-id>
AGENTICFORM_GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/agenticform-github-app.pem
```

The GitHub App private key remains on the control plane. Execution nodes request repository-scoped, short-lived installation tokens through signed device-authenticated requests. The token is supplied to Git on demand through a generation-scoped credential helper and is not persisted in the repository URL or node state.

The GitHub App must be installed on the repositories Agenticform is allowed to materialize. Repository URLs registered in Agenticform remain credential-free HTTPS URLs such as:

```text
https://github.com/owner/repository.git
```

## Design documents

- [Product reliability audit and repair plan (September 15, 2026)](docs/product-reliability-audit.md)
- [Initial architecture](docs/architecture.md)
- [Codex queue orchestration](docs/codex-queue.md)
- [Operational contracts](docs/operations.md)
- [Durable recovery and GitHub webhooks](docs/recovery.md)
- [Distributed Agent Fabric](docs/distributed-agent-fabric.md)
- [UI/UX specification](docs/ui-ux.md)
- [Self-Hosted Alpha](docs/self-hosted-alpha.md)

## Current architecture

```text
                        Agenticform Control Plane
                 ┌───────────────────────────────┐
                 │ PostgreSQL durable state      │
                 │ Project / Agent / Task        │
                 │ Communication fabric          │
                 │ Policy / approvals            │
                 │ Operational runbooks          │
                 │ Execution-node scheduler      │
                 │ Runtime generation fencing    │
                 └──────────────┬────────────────┘
                                │ outbound HTTPS
                   ┌────────────┼────────────┐
                   ▼            ▼            ▼
               node A       node B       node C
               Codex        Codex        Codex
               workspace    workspace    workspace
               ledger       ledger       ledger

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

Agenticform constrains side effects rather than reasoning: development agents remain free to discover, reason, modify, test, communicate, and collaborate, while production and other high-blast-radius effects pass through deterministic policy and runbook execution.
