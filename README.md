# Agenticom

Agenticom is a Java-based control plane for orchestrating multiple Codex agent sessions across applications hosted on a server.

The project is being designed around these core concepts:

- **Projects** — applications/repositories available on the server.
- **Agents** — Codex sessions with an explicit responsibility and workspace.
- **Tasks** — units of work assigned to agents.
- **Agent messaging** — structured communication and handoff between agents.
- **Workspaces** — isolated Git worktrees where appropriate.
- **Approvals** — explicit gates for sensitive actions such as merge, deploy, or destructive operations.

Initial architecture is proposed through pull requests before implementation begins.
