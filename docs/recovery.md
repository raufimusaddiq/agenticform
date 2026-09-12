# Durable Recovery and GitHub Webhooks

## Goal

Agenticform must not depend on a live Java thread, HTTP request, execution-node process, or webhook delivery for durable work to remain recoverable. PostgreSQL is authoritative for control-plane state; execution nodes persist only the minimum local runtime state required to reconcile effects safely.

## External operations

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

## External-work correlation

A durable GitHub wait is correlated by:

- repository;
- workflow;
- ref/head branch;
- exact expected commit SHA;
- dispatch correlation timestamp for `DISPATCH` mode.

`DISPATCH` operations require an exact expected head SHA. If concurrent dispatches make correlation ambiguous, Agenticform fails closed rather than choosing a workflow run probabilistically.

`WAIT` mode may observe a workflow that was already started by push/PR. The reconciler can discover an already-completed matching run even if its webhook was missed.

## Execution-node command effects

Node command delivery remains at-least-once. Command effects are made effectively-once by a persistent node-local ledger.

Before executing a command, the node stores:

```text
commandId
fingerprint(commandType + idempotencyKey + generation + payload)
state = STARTED
```

Terminal results are cached as `SUCCEEDED` or `FAILED` and are returned again when the same command is leased after a lost completion response.

If the node restarts and finds a command still in `STARTED`, Agenticform **does not replay the side effect**. The node returns an ambiguous-execution failure instead. This deliberately prefers a visible blocker over executing an uncertain side effect twice.

The ledger is stored under the node state directory with mode `0600` and atomic rename-based writes.

## Runtime generation fencing

Every remote logical agent has a monotonically increasing `runtimeGeneration`.

```text
logical Agent A
    generation 4 -> node-a

node-a lost
    |
    v
recovery
    |
    v
logical Agent A
    generation 5 -> node-b
```

Node commands, Codex notifications, server requests, Git credentials, command completions, and runtime snapshots are validated against the current `(executionNodeId, runtimeGeneration)` pair.

If node-a later reconnects and reports generation 4, its runtime is stale. It cannot mutate generation-5 task, message, approval, or agent state.

This is generation fencing, not live process migration.

## Node restart reconciliation

Execution nodes persist their runtime inventory locally:

```text
agentId
runtimeGeneration
threadId
sourceDirectory
workingDirectory
branch
runtimeStatus
```

Heartbeat sends this inventory to the control plane. If the observation matches the currently assigned node and generation, Agenticform can restore a `DISCONNECTED`/`STARTING` agent to its current runtime instead of creating a second Codex thread.

A snapshot from an older generation is recorded as stale and cannot replace the current runtime.

## Durable human approvals

Remote Codex approvals and user-input requests no longer depend on one long-running HTTP request.

```text
Codex on node
    |
    | signed begin request
    v
Remote interaction persisted
    |
    +-- PENDING -------------------------+
    |                                    |
    | human decision                     |
    v                                    |
READY / FAILED                           |
    ^                                    |
    | node polls after reconnect/restart |
    +------------------------------------+
    |
    | response delivered to Codex
    v
CONSUMED
```

A control-plane restart leaves a remote approval `PENDING`. Local in-process Codex approvals are still orphaned on control-plane restart because there is no remote durable interaction to reconnect to.

Moving an agent to another node while it has a pending human approval is forbidden. Resolve or cancel the approval first.

## Node-loss rehydration

Automatic recovery is enabled by default for eligible remote GIT agents after the configured grace period:

```bash
AGENTICFORM_NODE_RECOVERY_GRACE=2m
AGENTICFORM_NODE_AUTO_RECOVERY=true
```

Recovery is fail-closed. It requires:

1. the agent is remote and `DISCONNECTED`;
2. the assigned node is `OFFLINE`;
3. the grace period has elapsed;
4. the project is GIT-backed;
5. there is no pending human approval;
6. another eligible node with `codex` and `git` capacity exists.

The replacement runtime receives a new generation and a separate recovery branch. Any active durable task is reset from ambiguous runtime state and re-dispatched only after the replacement Codex runtime has been created successfully.

### Important recovery boundary

Rehydration restores **logical Agenticform state**, not volatile filesystem/process state from a permanently lost machine.

Durable state includes the agent identity, task prompt, message/audit records, policy state, operation state, and registered project source. A replacement node can re-run an active task from this durable state.

Local-only, uncommitted work that existed exclusively in a dead node's worktree cannot be recovered. If that work matters, it must have been committed/pushed or the original node must reconnect so its runtime can be reconciled instead of replaced.

Agenticform therefore does not describe node-loss recovery as live migration.

## Private GitHub repositories

Execution nodes never receive the control plane's long-lived GitHub token or GitHub App private key.

Configure a GitHub App on the control plane:

```bash
AGENTICFORM_GITHUB_APP_ID=<app-id>
AGENTICFORM_GITHUB_INSTALLATION_ID=<installation-id>
AGENTICFORM_GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/agenticform-github-app.pem
```

The private key must be PKCS#8 PEM (`BEGIN PRIVATE KEY`).

For Git operations, the node uses a Git credential helper that requests a short-lived GitHub App installation token on demand. The request is accepted only when all of these match current control-plane state:

- authenticated execution node;
- agent ID;
- current runtime generation;
- project ID;
- exact registered repository URL.

The installation token is restricted to the requested repository and `contents:write`. It is returned to the requesting Git process and is not stored in project metadata, repository URLs, workspace files, or persistent node state.

Repository URLs remain credential-free HTTPS URLs.

## Distributed workspace cleanup

Remote cleanup is a semantic node command, not arbitrary remote shell deletion.

A node refuses cleanup unless:

1. the command targets the current agent runtime generation;
2. the workspace is an isolated worktree, not the shared repository directory;
3. the worktree is inside the node-managed worktree root;
4. the worktree is clean (`git status --porcelain` is empty);
5. the branch is provably merged into the configured default branch.

Only after those checks does the node use `git worktree remove` and safe branch deletion.

Control-plane cleanup must additionally ensure there is no active task/turn and no pending human approval before enqueueing remote cleanup.

Existing local workspace cleanup rules remain:

1. the agent is not system-managed;
2. workspace mode is `ISOLATED_WORKTREE`;
3. there is no active task/turn and no non-terminal task assigned to the agent;
4. the worktree is clean;
5. the branch is provably an ancestor of the configured default branch;
6. the configured retention period has elapsed (default `24h`).

Configuration:

```bash
AGENTICFORM_WORKTREE_RETENTION=24h
AGENTICFORM_WORKTREE_CLEANUP_DELAY_MS=3600000
```

Local inspection and cleanup APIs remain:

```text
GET  /api/workspaces/agents/{agentId}/cleanup-inspection
POST /api/workspaces/agents/{agentId}/cleanup
GET  /api/workspaces/cleanup-history
```

## Restart behavior summary

After a control-plane restart:

- `QUEUED` operation runs are dispatched again by the durable execution scheduler;
- `WAITING_EXTERNAL` operation runs remain waiting and reconcile against GitHub;
- `RUNNING` host-local operation work becomes `INTERRUPTED` when completion cannot be proven;
- remote human approvals remain durable and can be polled by reconnecting nodes;
- execution-node runtime snapshots can reconnect current generations;
- stale generations remain fenced;
- terminal operation events remain durable until delivery succeeds or reaches the bounded retry limit.

After an execution-node restart:

- the same Ed25519 identity is reused;
- the durable command ledger prevents unsafe command replay;
- persisted runtime inventory is included in heartbeat reconciliation;
- the node resumes signed command polling;
- durable remote approvals can continue through poll/ack.

## Operational Agent continuation

When an operation becomes terminal, Agenticform persists an operation event. Delivery wakes the project's system-managed Operational Agent with the run ID and asks it to inspect `get_operation_status`.

The LLM then decides what to do next (report, investigate, rollback, or hand source changes back to a coding agent), while actual operational effects still require registered runbooks and deterministic policy.

## Failure model

Transport is never the source of truth.

- Webhooks are a fast path; persisted waits plus provider reconciliation are the fallback.
- Node command polling is at-least-once; the persistent command ledger fences duplicate effects.
- Node runtime identity is logical and centrally versioned; generation fencing prevents split brain.
- Remote approvals are persisted; one HTTP connection is not required to remain open.
- Replacement runtime recovery never claims to restore unrecoverable local-only filesystem state.

When Agenticform cannot prove that replay, cleanup, ownership, or continuation is safe, it blocks and requires reconciliation rather than guessing.
