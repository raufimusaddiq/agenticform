# Configuration

Agenticform reads settings from a single JSON file (`~/.config/agenticform/config.json`, or `AGENTICFORM_CONFIG`), with environment variables overriding file values:

**Precedence:** `environment variable` > `config.json` > `identity.json` (`hubUrl` on enrolled nodes) > `built-in default`

---

## Everyday CLI Setup

For local and single-operator use, you only need `af init` and `af config`:

```bash
# 1. Initialize a hub (auto-generates a 32-byte adminToken at mode 0600)
af init hub --port 8787

# 2. Initialize a client or agent caller (reads token from stdin)
printf '%s\n' "$TOKEN" | af init client --url https://hub.example.com

# 3. Initialize a node (or rely on `agenticform-node enroll`, which saves hubUrl in identity.json)
af init node --url https://hub.example.com --harnesses codex,claude --slots 2

# Inspect effective values and their source (`env`, `file`, or `default`), with secrets redacted:
af config show
af config path
af config set hub.port 9000
af config unset hub.port

# Secrets are always passed on stdin, never as CLI arguments:
printf '%s\n' "$TOKEN" | af config set token
```

### Supported `config.json` keys

| Key | Type | Default | Description |
|---|---|---|---|
| `hubUrl` | URL origin | `null` | Hub origin used by `af`, `agenticform-mcp`, `HubClient`, and `agenticform-node` |
| `token` | string (secret) | `null` | Scoped caller bearer token (`afc_...`) |
| `adminToken` | string (secret, ≥32 chars) | `null` | Hub / owner admin bearer token |
| `hub.port` | integer (`0..65535`) | `8787` | Hub listen port |
| `hub.publicUrl` | URL origin | `null` | Public HTTPS origin advertised by the hub |
| `hub.stateDir` | path | `~/.agenticform-hub` | Hub durable state directory |
| `hub.dbPath` | path | `$stateDir/hub.sqlite` | Explicit SQLite database path |
| `hub.maxDepth` | integer (`≥0`) | `3` | Maximum `parentRunId` nesting depth |
| `hub.workflowTimeoutMs` | integer (`≥1`) | `30000` | Active JS execution budget per Psychoscript workflow |
| `hub.workflowMaxChildRuns` | integer (`≥0`) | `20` | Maximum child runs per workflow |
| `node.name` | string | hostname | Node display name at enrollment |
| `node.stateDir` | path | `~/.agenticform-node` | Node durable state directory |
| `node.slots` | integer (`≥1`) | `1` | Concurrent commands accepted by the node |
| `node.harnesses` | string list | `[]` | Harness IDs advertised by the node |
| `node.capabilities` | string list | `[]` | Capability overrides advertised by the node |

---

## Essential Environment Variables

In containers, systemd units, and CI you can configure everything with environment variables instead of (or overriding) `config.json`:

| Variable | Package | Default | Meaning |
|---|---|---|---|
| `AGENTICFORM_CONFIG` | all | `~/.config/agenticform/config.json` | Override config file path (`XDG_CONFIG_HOME` is also respected) |
| `AGENTICFORM_HUB_URL` | hub, node, cli, mcp | none | Hub origin (`https://` required for non-loopback hosts) |
| `AGENTICFORM_ADMIN_TOKEN` | hub, cli, mcp | none | Secret. Admin bearer token (≥32 chars in hub); CLI/MCP prefer it over `AGENTICFORM_TOKEN` |
| `AGENTICFORM_TOKEN` | cli, mcp | none | Secret. Scoped `runs` caller token (`afc_<id>_<secret>`) |
| `AGENTICFORM_ENROLL_TOKEN` | node (`enroll`) | none | Secret. Single-use enrollment token issued by the hub |

---

## Advanced Tuning Variables

All internal timeouts, lease windows, replay limits, and test toggles keep sensible defaults and rarely need changes:

| Variable | Package | Default | Meaning |
|---|---|---|---|
| `AGENTICFORM_STATE_DIR` | hub, node | `~/.agenticform-hub`, `~/.agenticform-node` | Directory for durable state |
| `AGENTICFORM_HUB_DB` | hub | `$AGENTICFORM_STATE_DIR/hub.sqlite` | Explicit SQLite database path |
| `AGENTICFORM_HUB_PORT` | hub | `8787` | Listen port |
| `AGENTICFORM_RUN_MAX_DEPTH` | hub | `3` | Deepest `parentRunId` chain allowed (`422 depth_exceeded`) |
| `AGENTICFORM_MAX_BODY_BYTES` | hub | `1048576` | Maximum request body before `413 payload_too_large` |
| `AGENTICFORM_HEARTBEAT_SECONDS` | hub, node | `15` | Heartbeat interval |
| `AGENTICFORM_POLL_MS` | hub, node | `1500` | Empty-poll backoff / node poll interval |
| `AGENTICFORM_LEASE_SECONDS` | hub | `900` | Command lease length |
| `AGENTICFORM_LEASE_RENEW_SECONDS` | node | `300` | How often a node renews its lease |
| `AGENTICFORM_REQUEST_TIMEOUT_SECONDS` | node | `30` | Per-request timeout when calling the hub |
| `AGENTICFORM_HARNESS_PROBE_TTL_SECONDS` | node | `300` | Cache TTL for non-ready harness probe results |
| `AGENTICFORM_HARNESS_PROBE_READY_TTL_SECONDS` | node | `3600` | Cache TTL for `ready` harness probe results |
| `AGENTICFORM_HARNESS_PROBE_TIMEOUT_SECONDS` | node | `20` | Per-harness probe timeout |
| `AGENTICFORM_CLOCK_SKEW_SECONDS` | hub | `120` | Allowed signed-request clock skew |
| `AGENTICFORM_NODE_OFFLINE_SECONDS` | hub | `45` | Silence before a node is marked `OFFLINE` (must exceed heartbeat interval) |
| `AGENTICFORM_ENROLLMENT_TTL_SECONDS` | hub | `600` | Enrollment token lifetime |
| `AGENTICFORM_NONCE_TTL_SECONDS` | hub | `600` | Signed-request nonce lifetime |
| `AGENTICFORM_NONCE_CLEANUP_SECONDS` | hub | `600` | Nonce cleanup interval |
| `AGENTICFORM_RECOVERY_GRACE_SECONDS` | hub | `120` | Wait before a disconnected run may recover |
| `AGENTICFORM_NODE_NAME` | node | hostname | Name reported at enrollment |
| `AGENTICFORM_NODE_SLOTS` | node | `1` | Concurrent commands the node accepts |
| `AGENTICFORM_NODE_HARNESSES` | node | empty | Comma-separated harness IDs the node advertises |
| `AGENTICFORM_NODE_CAPABILITIES` | node | empty | Comma-separated capability overrides for the node |
| `AGENTICFORM_WORKFLOW_TIMEOUT_MS` | hub | `30000` | Active JS execution budget per workflow (ms) |
| `AGENTICFORM_WORKFLOW_MAX_OUTPUT_BYTES` | hub | `65536` | Maximum UTF-8 bytes retained for workflow result and logs |
| `AGENTICFORM_WORKFLOW_MAX_SNAPSHOT_BYTES` | hub | `524288` | Maximum serialized Psychoscript snapshot size in bytes |
| `AGENTICFORM_WORKFLOW_MAX_CHILD_RUNS` | hub | `20` | Maximum child runs a single workflow may create |
| `AGENTICFORM_WORKFLOW_MAX_CODE_BYTES` | hub | `65536` | Maximum UTF-8 bytes accepted in workflow `code` |
| `AGENTICFORM_WORKFLOW_PARK_MS` | hub | `50` | Delay before parking an awaiting workflow's VM snapshot to SQLite |
| `AGENTICFORM_CONFORMANCE_HARNESS` | runtime | unset | Opt-in: run the conformance suite against this harness; may use paid inference |
| `AGENTICFORM_REAL_HARNESS` | tests (node) | unset | Opt-in: set to `1` to run tests that spawn/probe real installed harness CLIs |
| `AGENTICFORM_CONFORMANCE_CWD` | runtime | process cwd | Working directory given to the conformance harness |
