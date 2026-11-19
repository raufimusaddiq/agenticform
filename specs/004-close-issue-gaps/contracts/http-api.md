# Contract: HTTP API additions

These extend `specs/002-node-hub/contracts/http-api.md`. Every route uses
`Authorization: Bearer <token>`. Errors use the existing
`{ "error": { "code", "message" } }` shape.

## 1. Authorization

| Token | Recognised by | Principal |
|---|---|---|
| `AGENTICFORM_ADMIN_TOKEN` | constant-time digest compare, unchanged | `admin` |
| `afc_<id>_<secret>` | row `id`, digest match, `revoked_at IS NULL` | `runs` |
| anything else | — | `401 unauthorized` |

A `runs` principal may call only the routes marked ✓ in the plan's route table.
Any other route is `403 forbidden`. A route missing from the table is admin-only.

## 2. Caller tokens (admin only)

`POST /v1/tokens`, with body `{ "name": "ci-agent", "scope": "runs" }` →
`201 { "id", "name", "scope", "createdAt", "token": "afc_…" }`. The `token` field
appears in this response only.

`GET /v1/tokens` → `200 { "tokens": [{ "id", "name", "scope", "createdAt", "lastUsedAt", "revokedAt" }] }`

`POST /v1/tokens/{id}/revoke` → `200` with the token view. Revoking an
already-revoked token returns it unchanged, so the call is idempotent.

Errors: `invalid_input` for a bad name or a scope other than `runs`;
`name_taken` (409) for a name already used by an active token; `not_found`.

## 3. Permissions

`GET /v1/runs/{id}/permissions` (admin and runs) →

```json
{ "permissions": [{
  "requestId": "call_7",            // the ACP toolCallId
  "generation": 1,
  "title": "Run `rm -rf build`",
  "kind": "execute",
  "options": ["allow", "deny"],
  "status": "pending",
  "decision": null,
  "requestedAt": "2026-11-19T10:00:00Z",
  "expiresAt": "2026-11-19T10:05:00Z"
}] }
```

Remote answers apply only to runs started with `permissionPolicy: "ask"` (`POST /v1/runs`,
default `"allow"`, also `"deny"`). Under `allow` or `deny` the runtime answers at once, no request is
ever pending, and the list shows each request as `resolved` with `by: "policy"` and the decision.

`POST /v1/runs/{id}/permissions/{requestId}` (admin only), with body
`{ "decision": "allow" | "deny" }` → `200` with the updated view
(`status: "answered"`).

| Error | HTTP | When |
|---|---|---|
| `forbidden` | 403 | the caller is a `runs` token |
| `not_found` | 404 | no such run or request in the run's current generation |
| `invalid_input` | 400 | the decision is not `allow` or `deny` |
| `permission_resolved` | 409 | the request is already answered, resolved or cancelled, or the run's policy is not `ask` |
| `permission_expired` | 409 | the current time is past `expiresAt` |
| `permission_unsupported` | 409 | the run's node does not advertise `permissions.remote` |

Two concurrent answers: exactly one returns 200, and the other returns
`permission_resolved`.

The events `permission.requested` and `permission.resolved` keep their runtime
shapes. The hub adds a `permission.answered` event
`{ requestId, decision, by: "admin" }` when it accepts an answer.

## 4. Run lineage

`POST /v1/runs` gains an optional field `"parentRunId": "<run id>"`. The run view
gains `"parentRunId": string | null` and `"depth": number`.

| Error | HTTP | When |
|---|---|---|
| `parent_not_found` | 404 | `parentRunId` names no run |
| `depth_exceeded` | 422 | `parent.depth + 1 > AGENTICFORM_RUN_MAX_DEPTH` |
| `idempotency_conflict` | 409 | the same key with a different `parentRunId` (existing rule) |

## 5. Follow under revocation

An SSE follow whose token is revoked receives
`event: error\ndata: {"code":"unauthorized"}` and is closed within 5 s of the next
keepalive, which is under 30 s.

## 6. Client, CLI and MCP

| Operation | client | CLI | MCP tool |
|---|---|---|---|
| issue token | `issueToken(name)` | `af token issue <name>` | — (owner only) |
| list tokens | `listTokens()` | `af token list` | — |
| revoke token | `revokeToken(id)` | `af token revoke <id>` | — |
| list permissions | `listPermissions(runId)` | `af run permissions <id>` | `list_permissions` |
| answer | `answerPermission(runId, requestId, decision)` | `af run answer <id> <requestId> allow\|deny` | `answer_permission` |
| submit with parent | `startRun({ …, parentRunId })` | `af run start … --parent <id>` | `start_run` `parentRunId` |

The CLI and MCP read the token from `AGENTICFORM_ADMIN_TOKEN` or
`AGENTICFORM_TOKEN`; the first one set wins. Neither accepts a token as an
argument. With a `runs` token, `answer_permission` returns the hub's `forbidden`
error unchanged.
