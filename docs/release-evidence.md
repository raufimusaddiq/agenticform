# Release evidence: close open issue gaps

This file records the manual evidence for spec 004 (FR-018 to FR-021). The
automated checks live in `bun test packages`; the runs below need real Linux
hosts, a real sandbox and, for the journey, two machines. Fill in the tables
with the host, date, versions and pass or fail for each step. Do not mark a step
passed without the command output that shows it.

Pass criteria: SC-005 (soak) and SC-006 (two-machine journey) in
[spec.md](../specs/004-close-issue-gaps/spec.md).

## 1. Soak (FR-018, SC-005)

Run on a Linux host with bubblewrap, from the repository root:

```bash
bun run scripts/soak.ts --hours 4 --restarts 3
```

The runner starts a real hub process and a real node (poller, executor, ledger,
signatures) against a sandboxed ACP child. It submits a mixed stream of runs —
complete, cancel, permission allow and permission timeout — and the permission
mixes go through the hub's `GET /v1/runs/{id}/permissions` and
`POST /v1/runs/{id}/permissions/{requestId}` routes, so the remote-answer path
is what is measured. It restarts the node three times, samples `VmRSS` every
60 s, records the harness process groups and checks them with `kill(-pgid, 0)`,
and counts runs without a terminal state.

It writes `soak-result.json` and exits non-zero on an orphaned process group, a
non-terminal run, or a final RSS over 120% of the baseline (the first sample
after warm-up, capped at one hour). A 2-minute smoke mode runs in
`packages/node/test/soak-smoke.test.ts`:

```bash
bun run scripts/soak.ts --minutes 2 --restarts 1
```

| Host | Date | Bun | Harness | Duration | Restarts | Peak RSS | Final RSS | Orphans | Non-terminal | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |  |  |

Attach `soak-result.json` to the issue comment; the table is the summary.

## 2. Two-machine journey (FR-019, SC-006)

The hub and the node run on separate Linux hosts. The node host must not share a
process namespace with the hub. Two harnesses are installed and authenticated by
the owner on the node host.

### Setup

1. On the hub host, set a token of at least 32 characters and start the hub:

   ```bash
   export AGENTICFORM_ADMIN_TOKEN="$(openssl rand -hex 32)"
   export AGENTICFORM_HUB_PORT=8787
   bun run packages/hub/bin/hub.ts
   ```

2. On the node host, point at the hub and enroll with both harnesses:

   ```bash
   export AGENTICFORM_HUB_URL=http://<hub-host>:8787
   export AGENTICFORM_STATE_DIR="$HOME/.agenticform-node"
   export AGENTICFORM_ENROLL_TOKEN=<token from POST /v1/enrollment-tokens>
   export AGENTICFORM_NODE_HARNESSES=claude,codex
   bun run packages/node/bin/node.ts enroll
   bun run packages/node/bin/node.ts run
   ```

3. On the hub host, confirm the node is online with both harnesses ready:

   ```bash
   export AGENTICFORM_HUB_URL=http://127.0.0.1:8787
   af nodes
   ```

### Completion on both harnesses

4. Start a run on the first harness and follow it to a terminal state:

   ```bash
   af run start --harness claude --prompt "say hello" --key journey-claude
   af run events <runId> --follow
   ```

   Expected: `completed`, with the harness's message in the events.

5. Repeat on the second harness:

   ```bash
   af run start --harness codex --prompt "say hello" --key journey-codex
   af run events <runId> --follow
   ```

   Expected: `completed` on the node host, not on the hub host.

### Remote permission answer

6. Start a run whose prompt makes the harness ask before running a shell
   command, then list the pending request:

   ```bash
   af run start --harness claude --prompt "run \`echo permission-check\`" --key journey-permission
   af run permissions <runId>
   ```

7. Answer it and follow the run:

   ```bash
   af run answer <runId> <requestId> allow
   af run events <runId> --follow
   ```

   Expected: `permission.answered` then `permission.resolved` with `allow`, and
   the run reaches a terminal state. Repeat once with `deny` and confirm the
   harness is told the denial. A second answer is refused with
   `permission_resolved`.

### Node-loss recovery

8. Start a long run, then kill the node process on the node host:

   ```bash
   af run start --harness claude --prompt "count slowly to 100" --key journey-recovery
   # on the node host
   pkill -9 -f "packages/node/bin/node.ts"
   ```

9. Wait for the hub to mark the run `disconnected` (after
   `AGENTICFORM_NODE_OFFLINE_SECONDS`, 45 s by default), restart the node, and
   recover the run:

   ```bash
   # on the node host
   bun run packages/node/bin/node.ts run
   # on the hub host
   curl -sS -X POST -H "authorization: Bearer $AGENTICFORM_ADMIN_TOKEN" \
     "$AGENTICFORM_HUB_URL/v1/runs/<runId>/recover"
   af run events <runId> --follow
   ```

   Expected: the run keeps its id, gets generation `N+1`, starts on a node and
   reaches a terminal state.

### Stale-generation rejection

10. With the pre-recovery node process still running (or restarted from its old
    state), let it try to complete its old command. The hub refuses the
    completion with `409 fence_stale` and the recovered run is unaffected. The
    node logs the code; the run's events show no duplicate completion.

    Expected: `fence_stale` in the node log, one terminal event for the run.

### Bad signature does not consume a nonce

11. On the node host, send one heartbeat with a corrupted signature and then the
    same nonce with the correct signature:

    ```bash
    bun -e '
    import { createHash, createPrivateKey, sign } from "node:crypto"
    import { readFileSync } from "node:fs"
    const state = process.env.AGENTICFORM_STATE_DIR
    const meta = JSON.parse(readFileSync(`${state}/identity/node.json`, "utf8"))
    const key = createPrivateKey(readFileSync(`${state}/identity/device.pem`, "utf8"))
    const body = JSON.stringify({ protocolVersion: 1, harnesses: [], capabilities: [], capacity: { slots: 1, inUse: 0 } })
    const nonce = "journey-nonce-0001"
    const timestamp = Date.now()
    const canonical = [meta.nodeId, timestamp, nonce, "POST", "/v1/node/heartbeat", createHash("sha256").update(body).digest("hex")].join("\n")
    const good = sign(null, Buffer.from(canonical), key).toString("base64")
    const bad = (good[0] === "A" ? "B" : "A") + good.slice(1)
    const send = (signature) => fetch(`${process.env.AGENTICFORM_HUB_URL}/v1/node/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-af-node-id": meta.nodeId, "x-af-timestamp": String(timestamp), "x-af-nonce": nonce, "x-af-signature": signature },
      body,
    })
    console.log("bad signature:", (await send(bad)).status)
    console.log("same nonce, good signature:", (await send(good)).status)
    '
    ```

    Expected: `401` then `200`. The failed attempt did not consume the nonce.

### No node listener

12. On the node host, confirm the node opens no listening socket:

    ```bash
    ss -ltnp | grep -E "bun|node" || echo "no node listener"
    ```

    Expected: `no node listener`. Every connection is outbound (FR-001).

### Results

| Step | Host | Date | Versions | Result | Notes |
|---|---|---|---|---|---|
| 3. node online, both harnesses ready |  |  |  |  |  |
| 4. completion on harness 1 |  |  |  |  |  |
| 5. completion on harness 2 |  |  |  |  |  |
| 6–7. remote permission allow |  |  |  |  |  |
| 7. remote permission deny |  |  |  |  |  |
| 8–9. node-loss recovery |  |  |  |  |  |
| 10. stale-generation rejection |  |  |  |  |  |
| 11. bad signature, nonce kept |  |  |  |  |  |
| 12. no node listener |  |  |  |  |  |

## 3. Packaging (FR-020)

```bash
bun run scripts/package-node.ts
```

The script builds the node with `bun build --compile` and as a
`bun install --production` workspace tree, lists the contents, fails if anything
beyond the node, its workspace dependencies and the runtime is included, and
measures size and cold start to the first heartbeat against a fake hub.

| Variant | Contents | Size | Cold start | Decision |
|---|---|---|---|---|
| compiled |  |  |  |  |
| install |  |  |  |  |

Record the chosen variant and its numbers here, then update the README Memory
section with the soak figures.

## 4. Memory record (FR-021)

Post the measured idle and soak memory of the hub and node on #73. The record
must state that the legacy stack has no baseline
([node-hub-invariants.md](node-hub-invariants.md)).
