# Contract: Runtime API

```ts
const runtime = createRuntime()
const run = runtime.run({
  harness: "codex",                 // catalog id or a custom HarnessDefinition
  cwd: "/absolute/path",
  prompt: "fix failing tests",
  requires: ["mcp.http"],           // optional
  mcpServers: [],                   // optional
  env: {},                          // optional additions to the child environment
  onPermission: async (request) => "deny", // optional; default denies
  signal,                           // optional AbortSignal
})

for await (const event of run.events()) { /* ... */ }
const result = await run.result()
await run.cancel()
await run.steer("new direction")
```

## Terminal states

| Status | Meaning |
|---|---|
| `completed` | The last turn ended with `end_turn` |
| `incomplete` | The agent stopped with `max_tokens`, `max_turn_requests` or `refusal` |
| `cancelled` | The caller cancelled |
| `failed` | The run failed; `error.code` is set |

## Error codes

`invalid_input`, `unknown_harness`, `spawn_failed`, `handshake_timeout`, `protocol_unsupported`, `capability_missing`, `auth_required`, `process_exited`, `agent_error`.

## Events

Each event has `runId`, `seq` and `at`. Types: `run.started`, `run.capabilities`, `turn.started`, `message.delta`, `thought.delta`, `tool.call`, `tool.update`, `plan`, `permission.requested`, `permission.resolved`, `turn.finished`, `other`, `run.finished`.
