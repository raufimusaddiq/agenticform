# Data Model: Close Open Issue Gaps

All new state is in the hub database. The node keeps permission waiters in
memory only, so a restart drops them, and the runtime has already denied on the
harness's side when its process died.

## caller_tokens (migration 4)

| Column | Type | Rule |
|---|---|---|
| `id` | TEXT PK | 12 chars base32, the visible part of `afc_<id>_<secret>` |
| `name` | TEXT NOT NULL | 1 to 64 chars, unique among unrevoked tokens |
| `scope` | TEXT NOT NULL | `runs` only; anything else is `invalid_input` |
| `digest` | TEXT NOT NULL | hex SHA-256 of the whole token |
| `created_at` | INTEGER NOT NULL | ms epoch |
| `last_used_at` | INTEGER NULL | updated at most once per 60 s |
| `revoked_at` | INTEGER NULL | set once; never cleared |

States: `active`, then `revoked` (terminal). A revoked token fails
authentication on its next use.

## permission_requests (migration 5)

| Column | Type | Rule |
|---|---|---|
| `run_id` | TEXT NOT NULL | FK `runs(id)` |
| `generation` | INTEGER NOT NULL | the run generation that asked |
| `tool_call_id` | TEXT NOT NULL | ACP id, at most 128 chars |
| `title` | TEXT NULL | at most 256 chars; longer values are refused at event append |
| `kind` | TEXT NULL | at most 64 chars |
| `status` | TEXT NOT NULL | `pending` \| `answered` \| `resolved` \| `timed_out` \| `cancelled` |
| `decision` | TEXT NULL | `allow` \| `deny` once answered or resolved |
| `requested_at` | INTEGER NOT NULL | hub receive time |
| `expires_at` | INTEGER NOT NULL | `requested_at + permissionTimeoutMs` (300 000) |
| `decided_at` | INTEGER NULL | |

The primary key is `(run_id, generation, tool_call_id)`.

Transitions (anything else is refused):

```text
pending ──owner answer──▶ answered ──permission.resolved──▶ resolved
pending ──permission.resolved (no hub answer, after expiry)──▶ timed_out
pending ──permission.resolved (no hub answer, before expiry)──▶ resolved   # e.g. harness cancelled it
pending | answered ──run ends / generation fenced──▶ cancelled
```

`answered` means the hub accepted an answer and queued it, and `resolved` means
the harness has its decision. Both count as "exactly one outcome" for SC-003.

## runs (migration 6)

| Column | Type | Rule |
|---|---|---|
| `parent_run_id` | TEXT NULL | must reference an existing run at insert |
| `depth` | INTEGER NOT NULL DEFAULT 0 | 0 with no parent, else `parent.depth + 1`; `≤ maxDepth` |

`parentRunId` is part of `request_json`, so the existing idempotency comparison
covers it.

## commands (no schema change)

New `type` value: `permission.answer`, with payload
`{ toolCallId, decision, generation, fingerprint }`. The idempotency key gains a
suffix: `run:{runId}:permission.answer:{toolCallId}:{generation}`.

## Release evidence (files, not tables)

| Artifact | Contents |
|---|---|
| `soak-result.json` | host, date, Bun, harness, duration, restarts, runs by outcome, RSS samples, peak and final RSS, orphans, non-terminal runs, pass or fail |
| `docs/release-evidence.md` | the two-machine journey steps and a results table; packaging decision table; memory record mirrored to #73 |
