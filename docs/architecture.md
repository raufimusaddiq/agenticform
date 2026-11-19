# Architecture

Agenticform is an execution fabric. Callers decide what should happen; Agenticform runs it on a chosen harness and machine and reports what happened.

```text
applications / scripts / agents
        │ library, HTTP, CLI or MCP
        ▼
client ─────► hub ◄───── node (machine A) ─► harness
              ▲
              └───────── node (machine B) ─► harness

runtime: used by node, and on its own for local runs
```

## Layers

**`runtime`** starts a harness, negotiates capabilities, runs turns and normalises events. It works alone, with no server.

**`node`** runs on each machine. It applies isolation and recovery, and connects outbound to the hub, so machines expose no inbound port.

**`hub`** is the connection point for nodes. It owns placement, fencing and the HTTP API. It never holds harness credentials.

**`client`** is the TypeScript SDK for the HTTP API. The CLI and MCP server are thin clients of the same API.

## Boundaries

Agenticform owns runs, sessions, events, permissions and results. Callers own tasks, plans, boards, roles and retries. Tools a caller wants the agent to have are passed as MCP servers.

## Why ACP

ACP gives one integration for many harnesses. Direct integrations can reach more harness-specific features, at the cost of one adapter per harness that must track each vendor. Work submitted and collected as runs does not depend on those features.

A direct driver can sit behind the `RuntimeDriver` boundary when a real need cannot be met through ACP. The reason is recorded when one is added.

## Honest differences

The API is uniform; harnesses are not. Each harness has a profile, either `coding` or `agentic`, and each connection reports capabilities. Callers state requirements and get a named error when they are not met.

Steering is emulated by cancelling a turn and sending a new prompt. Events mark it as emulated, because in-progress work is interrupted.

Agentic platforms may run tools through their own gateway, so a sandbox around the local process may not cover them. Those guarantees are not treated as equal to coding harnesses.

## Safety rules

- Permission requests are denied unless the owner allows them. Only one-time grants are selected.
- Unknown capabilities count as absent.
- Prompts are never retried automatically, because a lost reply is ambiguous.
- Harness stderr stays out of events, because it may contain sensitive output.
- The remote path carries outbound-only nodes, fenced runtime identity, single-use nonces, idempotency and isolation. See [node/hub invariants](node-hub-invariants.md).

## Authentication and caller tokens

Caller and operator routes require a bearer token (`Authorization: Bearer <token>`), either the admin token or a caller token. Calling agents, scripts and tools do not use the admin token; the owner issues scoped caller tokens for external callers instead.

- **Admin token** (`AGENTICFORM_ADMIN_TOKEN`): configured at hub startup (must be at least 32 characters). Holds full administrative authority: node management, issuing and revoking caller tokens, node enrollment, answering permission requests, and recovering disconnected runs.
- **Caller tokens** (`AGENTICFORM_TOKEN`): hub-issued, revocable bearer tokens scoped to `runs` (format `afc_<id>_<secret>`). Managed via `af token issue <name>`, `af token list`, and `af token revoke <id>` (or `POST /v1/tokens`). Stored as SHA-256 digests in SQLite. A `runs` token can submit runs, inspect runs, stream events via SSE, cancel runs, list nodes, and read pending permission requests. Any call to an administrative route is refused with `403 forbidden`.

When a caller token is revoked, authentication fails on its next request (`401 unauthorized`). Open SSE event streams re-authenticate at every keepalive and terminate with an `unauthorized` error event within 30 s of revocation.

## Permissions

A harness that asks before acting waits for the owner, not for the node. The
runtime's `permissionTimeoutMs` (300 s) is the only clock that denies.

```text
harness ──session/request_permission──▶ runtime ──onPermission──▶ node executor
node: emit permission.requested {toolCallId,title,kind} ──event batch──▶ hub
hub:  INSERT permission_requests (pending, expires_at = requested_at + 300 s)
owner ──POST /v1/runs/{id}/permissions/{toolCallId} {decision}──▶ hub
hub:  UPDATE ... SET status='answered' WHERE status='pending'  (exactly one wins)
      enqueue permission.answer {toolCallId, decision}
node ──lease (control lane)──▶ executor resolves the waiter ──▶ runtime ──▶ harness
runtime emits permission.resolved ──▶ hub marks the row resolved (or timed_out)
```

The owner can inspect pending requests via `af run permissions <id>` (or MCP `list_permissions`) and answer them remotely via `af run answer <id> <requestId> allow|deny` (or MCP `answer_permission`, or the operator UI at `/`). Only the admin token answers; a `runs` token may read the list but cannot answer (`403 forbidden`). A node that does not advertise `permissions.remote` is refused with `permission_unsupported` rather than emulated. A duplicate answer through the API gets `409 permission_resolved`, and the node completes a duplicate command with `{ applied: false }`, so the harness is never told twice. Run end cancels every open request in the same transaction as the status change, and a node restart never re-asks.

## Run lineage

Runs can be linked in parent-child hierarchies by supplying `--parent <runId>` on submission (`parentRunId` on `POST /v1/runs`, or `parentRunId` in the MCP `start_run` tool). The hub records `parentRunId` and tracks tree depth: a root run has `depth: 0`, and a child run has `depth: parent.depth + 1`.

To bound agent recursion and protect against runaway self-invoking agent cascades, the hub enforces a maximum depth via `AGENTICFORM_RUN_MAX_DEPTH` (default `3`). Submissions that would exceed this limit are rejected before inserting a database record with `422 depth_exceeded`. If the specified `parentRunId` does not exist, the submission returns `404 parent_not_found`. Submissions with the same idempotency key and same parent return the existing run; matching key with a different parent returns `409 idempotency_conflict`.

## Isolation

Every run is wrapped in a bubblewrap sandbox built from the harness's profile:
minimal read-only system binds, a private `/tmp` and home, the resolved
workspace bound read-write (or read-only), and only the harness's declared state
directories. A safe entry-point directory is bound read-only and put on the
sandbox `PATH`; a temp root or a workspace ancestor binds only the resolved
entry file and its interpreter, so siblings stay invisible and the private
`/tmp` is preserved. A write outside those paths fails with `EROFS`. The node
never runs a harness unsandboxed: a sandbox that cannot start fails the run.

The heartbeat reports each configured harness's probe status and advertises only
the ready ones. It also reports the isolation mode, profile version and self-test
outcome. At startup the node proves the sandbox shape with a self-test; when it
fails, the node advertises no harnesses, probes none and refuses every run with
`isolation_unavailable` until restart.

The boundary is the local harness child. `runtime` spawns it and knows nothing
about the sandbox; the node wraps the harness definition so the child is
`bwrap -- ...`. A gateway-backed harness may run tools through its own service,
outside that child, so the filesystem guarantee covers only the local process and
is not claimed equal to a coding harness. See
[harnesses](harnesses.md#isolation-limit).

## Process lifecycle

Each run owns one child process, which leads its own process group, so wrappers such as `bunx` are stopped with their children. Cancellation has a grace period, after which the process is stopped.

Runs keep their events in memory. Durability belongs to `node` and `hub`: the
node writes a command ledger before any effect, and the hub keeps runs, commands
and events in SQLite with WAL.

## Evidence and verification

Release qualification and verification artifacts:
- [Release evidence](release-evidence.md): test procedures and recorded results for the two-machine journey, multi-hour soak runs, and node packaging.
- Soak test runner: [`scripts/soak.ts`](../scripts/soak.ts) tests multi-hour RSS stability across node restarts, orphan process cleanup, and remote permission mixes.
- Node packaging test: [`scripts/package-node.ts`](../scripts/package-node.ts) measures size and cold-start latency for standalone binary builds (`bun build --compile`) versus production install trees (`bun install --production`).

## History

An earlier Java control plane, Go node and React UI were removed once the Bun
packages covered their behaviour. They are not part of this repository; their
code and documentation remain in git history at commit `14a1464`.
