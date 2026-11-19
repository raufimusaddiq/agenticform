# Research: Close Open Issue Gaps

No `NEEDS CLARIFICATION` remained after the spec. The owner decided remote
permission answers on 2026-11-19. Each decision below was settled by reading the
code on `main` at `1f03e78`.

## R1. Caller token format and storage

- **Decision**: `afc_<id>_<secret>`, where `id` is 12 random base32 characters
  and `secret` is 32 random bytes in base64url. The hub stores
  `sha256(token)` and compares it with `timingSafeEqual`. The secret is returned
  once, at issue.
- **Rationale**: the admin token check in `server.ts` (`authenticateBearer`)
  already compares SHA-256 digests in constant time. A 256-bit random secret
  cannot be brute-forced, so a slow KDF (argon2, scrypt) only costs CPU on a
  1 CPU host. The `id` prefix gives an indexed lookup instead of a scan, and lets
  a leaked token be recognised in logs without its secret.
- **Alternatives**: signed JWTs were rejected, because they need a key, rotation
  and a revocation list anyway (VII). Unprefixed opaque tokens were rejected,
  because they need a digest scan per request.

## R2. Where a scope is enforced

- **Decision**: one route table in `server.ts`, mapping method and path pattern
  to allowed scopes. Unlisted routes are admin-only.
- **Rationale**: the caller routes are dispatched in one `handle` function after
  `authenticateBearer`, so the guard belongs at that single point. Default-deny
  for unlisted routes keeps fail-closed (IV) when a route is added later.
- **Alternatives**: a per-handler check was rejected, because it is easy to forget
  on a new route.

## R3. Revocation of an open follow

- **Decision**: the SSE loop re-authenticates at each keepalive (every 20 idle
  ticks of 250 ms, so 5 s). A JSON events page is a single request and needs no
  re-check.
- **Rationale**: `sse()` already loops with a keepalive, so a check there costs one
  indexed read per 5 s per stream and meets the 30 s bound (FR-003).

## R4. Permission options

- **Decision**: the answer is `allow` or `deny`, the runtime's `PermissionDecision`.
  The hub view lists the offered options as `["allow", "deny"]`.
- **Rationale**: `runtime` already maps ACP `session/request_permission` options to
  allow or deny for every harness (`acp-driver.ts` `onPermission`). It picks the
  harness's matching option, or cancels when none exists (spec 001 edge case).
  Exposing raw ACP option ids would leak per-harness differences into the HTTP
  contract (III), and `allow_always` would let one answer silently cover later
  requests.
- **Alternatives**: forwarding raw ACP options was rejected for the reasons above.
  It can be added later as a capability if a caller needs it.

## R5. Which clock denies

- **Decision**: the runtime's `permissionTimeoutMs` (default 300 s) is the only
  clock that denies the harness. The hub stores `expires_at` from the same default
  and refuses later answers with `permission_expired`.
- **Rationale**: the runtime timer runs next to the harness, so it still denies when
  the hub is unreachable. A second hub-side deny would race it. The hub's copy
  exists only to refuse a late answer cleanly.
- **Alternatives**: a hub-driven timeout was rejected, because the node may be cut
  off from the hub and must still deny.

## R6. Delivering an answer to an outbound-only node

- **Decision**: a new command type, `permission.answer`, on the existing command
  queue. The poller leases it in the control lane, as for `run.cancel`. The
  idempotency key is `run:{id}:permission.answer:{toolCallId}:{generation}`.
- **Rationale**: the poller already leases `run.cancel` and `run.inspect` while
  `run.start` slots are full, so answers are not starved. Commands are fenced by
  generation and fingerprinted, and the node ledger admits each command id once.
  That gives at-most-once delivery for free (FR-009, FR-012).
- **Change needed**: `enqueueCommand` derives its key as
  `run:{id}:{type}:{generation}`, which allows one command per type per
  generation. It gains an optional key suffix, used only by `permission.answer`.

## R7. Compatibility without a protocol bump

- **Decision**: the node advertises the capability `permissions.remote` in its
  heartbeat. The hub refuses an answer for a run whose node does not advertise it.
  The protocol version stays 1.
- **Rationale**: a hub must not enqueue a command type that an older node would
  fail on. Capabilities are already the way a node declares what it supports, and
  an unknown capability counts as absent (IV).

## R8. Lineage storage

- **Decision**: columns `parent_run_id TEXT NULL REFERENCES runs(id)` and
  `depth INTEGER NOT NULL DEFAULT 0` on `runs`, plus `AGENTICFORM_RUN_MAX_DEPTH`
  (default 3, minimum 0).
- **Rationale**: one parent pointer and an integer answer the only question asked
  ("how deep is this run?") without a recursive query. The parent must exist when
  the child is inserted, so a cycle cannot form.

## R9. Soak and packaging measurement

- **Decision**: a Bun script reads `VmRSS` from `/proc/<pid>/status`, the method the
  README already uses. It finds orphans by recording each harness's process group
  and checking `kill(-pgid, 0)` after the run ends. Packaging compares
  `bun build --compile` with a production install.
- **Rationale**: this reuses the measurement method already published in the
  README, so the soak figures are comparable with the idle figures. It needs no
  monitoring dependency.

## R10. CI job-minutes for #75

- **Decision**: take the per-run durations of the `CI` workflow from
  `gh run list --workflow ci.yml --json` for 20 PR runs before
  `7947aef` (the retired-stack workflows) and 20 after `14a1464`, using `gh api`
  run timing where it is available. Post the median and the total on #75.
- **Rationale**: FR-024 asks for job-minutes from run history, with no pricing
  claims. The figure is measured once and posted; no tooling is added.
