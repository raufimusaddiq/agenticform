# Operational Intelligence

## Purpose

Operational Intelligence turns durable operational evidence into structured incidents that can wake the project's Operational Agent.

The design keeps three responsibilities separate:

```text
Deterministic observation
        ↓
Durable signals
        ↓
Deterministic correlation / incident rules
        ↓
Operational Agent reasoning
        ↓
Deterministic policy + runbook effects
```

The LLM does not decide whether raw health checks, node loss, or operation failure happened. Agenticform records those facts deterministically. The Operational Agent interprets correlated evidence, coordinates other agents, and chooses a mitigation. Any real operational effect still goes through `request_operation` and the existing policy/runbook boundary.

## Signals

`operational_signals` stores durable evidence with:

- project
- source
- signal type
- severity
- fingerprint
- optional correlation key
- JSON evidence payload
- occurrence count
- first/last observed timestamps
- lifecycle status

Repeated active signals with the same project/fingerprint update one durable signal and increment `occurrence_count`. Once a signal episode is resolved or suppressed, a later failure may create a new episode.

Current deterministic producers include:

- terminal operation runs
- execution-node loss while agents are active
- registered service health/readiness probes

The public admin API may also record a signal explicitly when another deterministic integration is the producer.

## Incident rules

Current built-in rules are intentionally small and explicit:

| Signal | Incident | Threshold | Minimum severity |
| --- | --- | ---: | --- |
| `OPERATION_FAILED` | `OPERATION_FAILURE` | 1 | HIGH |
| `DEPLOY_FAILED` / `GITHUB_WORKFLOW_FAILED` | `DEPLOYMENT_FAILURE` | 1 | HIGH |
| `EXECUTION_NODE_OFFLINE_ACTIVE` | `EXECUTION_NODE_LOST` | 1 | HIGH |
| `SERVICE_HEALTH_FAILURE` | `SERVICE_DEGRADED` | 3 | HIGH |
| `AGENT_RUNTIME_FAILED` | `AGENT_RUNTIME_FAILURE` | 1 | WARNING |
| `DISK_CRITICAL` | `DISK_CAPACITY_CRITICAL` | 1 | CRITICAL |
| `BACKUP_STALE` | `BACKUP_STALE` | 1 | HIGH |

Rules are deterministic. A signal below its threshold remains evidence but does not wake an LLM.

Service health failures are episode based. A successful probe after failures resolves the active failure signal and records `SERVICE_HEALTH_RECOVERED`. If a `SERVICE_DEGRADED` incident is already open, the recovery signal is attached as new evidence and may wake the Operational Agent again. Recovery evidence never auto-resolves an incident: the agent/operator must verify stability and explicitly resolve it.

## Incident lifecycle

```text
OPEN
  ↓
INVESTIGATING
  ↓
MITIGATING
  ↓
RESOLVED
```

An incident may also be `SUPPRESSED` with an explicit reason.

`RESOLVED` and `SUPPRESSED` are terminal and cannot be reopened implicitly. A future independent failure creates a new signal episode and, when its rule matches, a new incident.

Resolving or suppressing an incident also resolves/suppresses its linked signal evidence.

## Operational Agent wake delivery

Every new actionable incident starts with a durable wake state:

```text
PENDING → QUEUED → DELIVERED
                  ↘ FAILED
```

Local Operational Agents are delivered through the local Codex gateway. Remote Operational Agents are delivered through the execution-node command fabric and therefore inherit Sprint 12 runtime-generation fencing and durable node-command semantics.

Remote wake uses a stable Codex client message id for the incident/runtime generation. The node command itself is attempt scoped.

If a remote node command reaches a terminal failure, Agenticform does **not** automatically create another command. A node crash may have crossed the Codex side-effect boundary before Agenticform could prove completion. The incident remains `FAILED` and requires explicit `retry-wake`; this preserves the same fail-closed principle used by Sprint 12 command recovery.

Failures that happen before a remote command exists can be retried automatically within the bounded wake-attempt limit.

## Operational Agent tools

Operational intelligence adds native Agenticform tools:

- `list_operational_signals`
- `list_incidents`
- `get_incident`
- `update_incident`

Signal and incident inspection is read-only and available to project agents for collaboration. `update_incident` is restricted to the persisted `OPERATIONAL` role.

The Operational Agent is instructed to fetch current incident evidence rather than trusting only the wake prompt. This matters because more evidence can arrive after the initial notification.

For mitigation the agent can still:

- message or broadcast to project agents for parallel investigation;
- inspect runbooks and operation state;
- call `request_operation` for deterministic effects.

It does not receive production credentials.

## Service health monitor

Enabled registered services with `healthUrl` and/or `readinessUrl` are probed periodically (default 30 seconds).

Configuration override:

```bash
AGENTICFORM_SCHEDULER_SERVICE_HEALTH_DELAY_MS=30000
```

Only credential-free `http`/`https` URLs are probed. No user credentials or Agenticform secrets are attached to probe requests.

Three consecutive failure observations open a `SERVICE_DEGRADED` incident. A successful probe closes the active failure episode and records recovery evidence.

## API and UI

Admin API:

```text
GET  /api/operational-intelligence/signals
POST /api/operational-intelligence/signals
GET  /api/operational-intelligence/incidents
GET  /api/operational-intelligence/incidents/{incidentId}
POST /api/operational-intelligence/incidents/{incidentId}/status
POST /api/operational-intelligence/incidents/{incidentId}/retry-wake
```

The Operations UI presents:

- open/high/critical incident counts;
- incident severity, lifecycle, and wake status;
- correlated signal evidence;
- suspected revision when present in evidence;
- investigation/mitigation/resolution/suppression actions;
- explicit wake retry after a fail-closed remote delivery;
- recent operational signals alongside existing runbooks and operation evidence.

## Failure model

PostgreSQL remains the source of truth for signals, incidents, correlations, and wake state.

Agenticform does not infer success when evidence is ambiguous:

- signal threshold not reached → no incident;
- remote wake command terminal/ambiguous failure → no automatic second command;
- recovery probe → evidence only, not automatic incident resolution;
- mitigation → must pass deterministic policy/runbook controls;
- terminal incident → cannot be silently reopened.

This keeps higher operational autonomy above the same constrained-effects boundary used by the rest of Agenticform.
