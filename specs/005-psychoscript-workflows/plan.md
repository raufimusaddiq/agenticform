# Implementation Plan: Psychoscript Durable Workflows & Script Runtime

## Architecture & Layering

```text
callers / agents (MCP, CLI, SDK, apps)
   │
   ├─► local library (@agenticform/script + HubClient, `af script`)
   │
   └─► hub HTTP API (/v1/workflows, `af workflow`, MCP *_workflow)
          └─► WorkflowManager (packages/hub/src/workflows.ts)
                 └─► @agenticform/script (psychoscript VM + Host.durableFn)
                        └─► in-process ScriptRunsPort -> SQLite (hub.sqlite v8)
```

- **`packages/protocol`**: Adds `WorkflowStatus`, `WorkflowLimits`, `WorkflowRequest`, `WorkflowError`, `WorkflowView`, and `ErrorCode` values `script_invalid`, `workflow_limit_exceeded`. Node wire protocol (`PROTOCOL_VERSION = 1`) is unchanged.
- **`packages/script` (`@agenticform/script`)**: Wraps `psychoscript`'s `Runtime.make`, `Host.durableFn`, `Host.fn`, `parseProgram`, `toBytes`, and `fromBytes` behind `ScriptRunsPort`. Exposes only `af.{run, startRun, getRun, cancelRun, listNodes, listEvents, listPermissions}` with deterministic child idempotency keys (`${run.id}:${userKey ?? call.key}`), `parentRunId` propagation, and `maxChildRuns` / `timeoutMs` / `maxOutputBytes` / `maxSnapshotBytes` enforcement.
- **`packages/hub`**:
  - Migration v8 creates `workflows` table (`snapshot_bytes BLOB`, `child_run_ids_json`, `waiting_run_ids_json`, etc.).
  - `WorkflowManager` drives active workflows, parks waiting workflows to `snapshot_bytes` after `workflowParkMs`, wakes suspended workflows on `notifyRunChanged(runId)` (after `completeCommand` and `cancelRun`) plus periodic `sweep()`, and enforces fail-closed crash recovery (`recoverOnStartup()`).
- **`packages/client`, `packages/cli`, `packages/mcp`**: Thin client parity (`createWorkflow`, `listWorkflows`, `getWorkflow`, `cancelWorkflow`; `af workflow ...` & `af script ...`; MCP `start_workflow`, `get_workflow`, `list_workflows`, `cancel_workflow`).
