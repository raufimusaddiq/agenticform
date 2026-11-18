# Quickstart: validate spec 004

## Prerequisites

- Linux with bubblewrap and Bun 1.4.4; then `bun install --frozen-lockfile`.
- `AGENTICFORM_ADMIN_TOKEN` set to at least 32 characters.
- For the two-machine journey: a second Linux host that can reach the hub, with
  two harnesses installed and authenticated by the owner.

## 1. Automated checks

```bash
bun run typecheck
bun test packages
```

Expected: everything passes. The new failure-boundary cases are in
`packages/hub/test/tokens.test.ts`, `packages/hub/test/permissions.test.ts`,
`packages/hub/test/runs.test.ts` (lineage) and
`packages/node/test/permissions.test.ts`.

## 2. Scoped token (US1)

```bash
af token issue demo                 # prints afc_… once
export AGENTICFORM_TOKEN=afc_…  ; unset AGENTICFORM_ADMIN_TOKEN
af nodes                            # ok
af run start --harness claude --prompt "say hi" --key demo-1   # ok, prints run id
af run events <id> --follow         # ok
af token list                       # forbidden
```

Then, with the admin token, run `af token revoke <id>`. The open follow ends
within 30 s with `unauthorized`. See [contracts/http-api.md](contracts/http-api.md) §1–2 and §5.

## 3. Permission answer (US2)

Start a run whose prompt makes the harness ask before running a shell command.
Then:

```bash
af run permissions <id>             # one pending request, options allow|deny
af run answer <id> <requestId> allow
af run events <id>                  # permission.answered then permission.resolved
```

Try again with `deny`, and once with no answer. That one ends `timed_out` after
300 s. A second answer is refused with `permission_resolved`. See
[contracts/http-api.md](contracts/http-api.md) §3.

## 4. Depth limit (US3)

Submit runs with `--parent <previous id>` four times, starting from a root. The
fourth child (depth 4) fails with `depth_exceeded`, and `af run get` shows
`depth` 0 to 3 for the others.

## 5. Release evidence (US4)

```bash
bun run scripts/soak.ts --hours 4 --restarts 3     # writes soak-result.json, exit 0 = pass
bun run scripts/package-node.ts                    # prints size and start-time table
```

Follow the two-machine steps in `docs/release-evidence.md` and fill in its
results table. Pass criteria are SC-005 and SC-006 in [spec.md](spec.md).

## 6. Issue status (US5)

Post the soak and memory record on #73, the CI minutes on #75 (research R10),
and close each issue whose remaining items are merged.
