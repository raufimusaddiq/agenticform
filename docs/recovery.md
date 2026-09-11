# Durable Recovery and GitHub Webhooks

## Goal

Agenticform must not keep a Java thread alive while an external CI/CD provider runs. External work is represented as durable state in PostgreSQL and can survive control-plane restarts.

```text
Operational Agent
      |
      | request_operation
      v
Runbook executor
      |
      | GITHUB_WORKFLOW
      v
WAITING_EXTERNAL  <------------------------------+
      |                                             |
      | persisted external wait                     |
      |                                             |
      +-- GitHub workflow_run webhook (fast path) --+
      |                                             |
      +-- GitHub API reconciliation (fallback) -----+
      |
      v
QUEUED -> resume next runbook step
      |
      v
terminal operation
      |
      v
Durable operation event -> wake Operational Agent
```

Host-local steps are treated differently. If Agenticform restarts while a local command is `RUNNING`, the operation becomes `INTERRUPTED`: completion cannot be proven, so Agenticform refuses to replay it automatically.

## GitHub webhook setup

Configure the control plane:

```bash
AGENTICFORM_GITHUB_TOKEN=...
AGENTICFORM_GITHUB_WEBHOOK_SECRET=use-a-long-random-secret
```

GitHub webhook URL:

```text
https://<agenticform-host>/api/webhooks/github
```

Subscribe to:

```text
Workflow runs (workflow_run)
```

Use the same random value for the GitHub webhook secret and `AGENTICFORM_GITHUB_WEBHOOK_SECRET`.

Agenticform verifies `X-Hub-Signature-256` with HMAC-SHA256 before parsing the payload. `X-GitHub-Delivery` is persisted as a dedupe key. Replaying the same delivery ID with different payload bytes is rejected.

The webhook secret is independent from `AGENTICFORM_GITHUB_TOKEN`. The webhook secret authenticates inbound events; the API token is used for workflow dispatch/reconciliation.

## Correlation

A durable GitHub wait is correlated by:

- repository
- workflow
- ref/head branch
- exact expected commit SHA
- dispatch correlation timestamp for `DISPATCH` mode

`DISPATCH` operations require an exact expected head SHA. If concurrent dispatches make correlation ambiguous, Agenticform fails closed rather than choosing a workflow run probabilistically.

`WAIT` mode may observe a workflow that was already started by push/PR. The reconciler can discover an already-completed matching run even if its webhook was missed.

## Restart behavior

After restart:

- `QUEUED` runs are dispatched again by the durable execution scheduler.
- `WAITING_EXTERNAL` runs remain waiting and are reconciled against GitHub.
- `RUNNING` host-local work becomes `INTERRUPTED` because its side effect cannot be safely inferred.
- terminal operation events remain durable until delivery to the Operational Agent succeeds or reaches the bounded retry limit.

## Operational Agent continuation

When an operation becomes terminal, Agenticform persists an operation event. Delivery wakes the project's system-managed Operational Agent with the run ID and asks it to inspect `get_operation_status`.

The LLM then decides what to do next (report, investigate, rollback, or hand source changes back to a coding agent), while actual operational effects still require registered runbooks and deterministic policy.

## Workspace lifecycle

Coding worktrees are disposable only when Agenticform can prove cleanup is safe.

Automatic cleanup requires all of these:

1. the agent is not system-managed;
2. workspace mode is `ISOLATED_WORKTREE`;
3. there is no active task/turn and no non-terminal task assigned to the agent;
4. the worktree is clean (`git status --porcelain` is empty);
5. the agent branch is provably an ancestor of the project's configured default branch;
6. the configured retention period has elapsed (default `24h`).

Configuration:

```bash
AGENTICFORM_WORKTREE_RETENTION=24h
AGENTICFORM_WORKTREE_CLEANUP_DELAY_MS=3600000
```

Manual inspection and cleanup:

```text
GET  /api/workspaces/agents/{agentId}/cleanup-inspection
POST /api/workspaces/agents/{agentId}/cleanup
GET  /api/workspaces/cleanup-history
```

Cleanup uses `git worktree remove`, attempts safe local branch deletion with `git branch -d`, records estimated freed bytes, and marks the agent `STOPPED`. Shared project workspaces and the system-managed Operational Agent are never automatic cleanup targets.

## Failure model

Webhook transport is an optimization, not the source of truth. PostgreSQL operation state remains authoritative and GitHub API reconciliation is the fallback. This means a dropped webhook, duplicate delivery, or Agenticform restart does not require a human to reconstruct the workflow state manually.
