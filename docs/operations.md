# Agenticform Operational Contracts

## Purpose

Agenticform operational runbooks are safe actuators for agent intent. They do not replace agentic reasoning, coding, debugging, architecture work, or collaboration.

The default project model is:

```text
Coding / Reviewer / General Agent
  discover / reason / modify / targeted-test / collaborate
        |
        | durable HANDOFF / REQUEST
        v
System-managed Operational Agent
  inspect CI / release readiness / health / migration needs
  choose operational intent / coordinate failures / report results
        |
        | request_operation
        v
Deterministic Policy Layer
  ALLOW / REQUIRE_HUMAN / DENY
        |
        v
Operational Layer
  snapshot / execute / verify / audit
```

The Operational Agent is still an agentic LLM. The Operational Layer is not. This separation keeps reasoning adaptive while production effects remain deterministic.

Every active project gets at most one system-managed `OPERATIONAL` agent. Provisioning is lazy so project registration does not fail merely because Codex is temporarily unavailable: spawning a normal agent guarantees the Operational Agent is provisioned first, and operators can explicitly provision it from the Operations UI/API for existing projects.

The Operational Agent uses the shared project workspace to avoid creating another writer worktree. It does not own production credentials and is not intended to edit application source. When source changes are required, it hands work back to coding agents through Agenticform messaging.

Agenticform enforces separation of duties at the dynamic-tool boundary: only the `OPERATIONAL` role may call `request_operation`. General agents use `handoff_to_operations`, which creates a durable agent-to-agent message to the project's default Operational Agent.

For coding tasks, Agenticform is intentionally **remote-CI-first**. Expensive full-suite validation, production image builds, release publication, and deployment should normally run on GitHub Actions when a project exposes suitable runbooks. Local worktrees remain temporary coding workspaces, not CI build hosts.

Execution nodes advertise runtime inventory separately from node trust. For example, `runtimes.CODEX.available` reports executable presence while `runtimes.CODEX.authenticated` reports usable node-local credentials. Placement uses runtime requirements; neither heartbeat capability nor runtime authentication grants control-plane authorization.

General/non-coding tasks are not forced through GitHub Actions. They may use normal agent tools or local deterministic runbooks when that is the correct execution surface.

## Typed steps

Runbooks currently support:

- `ASSERT_GIT_CLEAN`
- `ASSERT_GIT_SHA`
- `COMMAND`
- `HTTP_CHECK`
- `SERVICE_CHECK`
- `GITHUB_WORKFLOW`

`COMMAND` is argv-based and does not invoke an implicit shell. It remains useful for bounded host-local operations, but it should not be used to recreate an existing remote CI/CD workflow.

## GitHub Actions step

`GITHUB_WORKFLOW` has two modes.

### WAIT

Use when GitHub Actions is already triggered by a push or pull request. Agenticform waits for the workflow associated with the exact commit SHA and records the resulting workflow-run metadata.

```json
{
  "key": "ci",
  "name": "Wait for CI",
  "type": "GITHUB_WORKFLOW",
  "timeoutSeconds": 1800,
  "config": {
    "mode": "WAIT",
    "repository": "owner/repository",
    "workflow": "ci.yml",
    "ref": "feature/my-branch",
    "headSha": "${param:sha}"
  }
}
```

### DISPATCH

Use for explicit remote actions such as release-image publication or deployment.

```json
{
  "key": "deploy",
  "name": "Deploy production release",
  "type": "GITHUB_WORKFLOW",
  "timeoutSeconds": 1800,
  "config": {
    "mode": "DISPATCH",
    "repository": "owner/repository",
    "workflow": "deploy-production.yml",
    "ref": "main",
    "inputs": {
      "sha": "${param:sha}"
    }
  }
}
```

If multiple matching workflow-dispatch runs appear in the dispatch correlation window, Agenticform fails closed instead of guessing which run belongs to the operation.

GitHub credentials are server configuration (`AGENTICFORM_GITHUB_TOKEN`) and are never persisted in runbook parameters or operation evidence.

## Agent tools

General agents receive:

- `list_agents`
- `send_message`
- `handoff_to_operations`
- `list_policy_rules`
- `list_runbooks` for inspection
- `get_operation_status` when they have a run id

The system-managed Operational Agent additionally has authority to use:

- `request_operation`

The tool is exposed in the common Codex namespace, but Agenticform rejects `request_operation` unless the calling persisted agent role is `OPERATIONAL`. This is an authorization boundary, not only a prompt convention.

A registered runbook evaluates deterministic policy as part of `request_operation`; the Operational Agent should not request a separate policy approval for the same operation.

## Recommended coding lifecycle

```text
Coding Agent worktree
  |
  | edit / targeted test / commit
  v
Push branch / PR
  |
  | handoff_to_operations when CI/release coordination is needed
  v
Operational Agent
  |
  | inspect / wait for CI / decide next operational intent
  v
GitHub Actions CI
  | full tests / integration tests / builds
  v
Merge main
  |
  v
GitHub Actions release
  | build immutable image sha-<commit>
  | push registry
  v
Operational Agent request_operation
  |
  v
Agenticform deterministic policy gate
  |
  | production boundary may REQUIRE_HUMAN
  v
Operational runbook
  | dispatch deploy workflow
  v
Production host
  | pull immutable image
  | migrate / restart
  | health + readiness verification
  v
Operational Agent
  | inspect evidence / rollback or investigate if needed
  | report result to coding/requesting agent
```

The production host does not need to build application images. Image retention should normally keep only the releases required for current operation and rollback.

## Richmod mapping

Richmod already demonstrates this model:

1. `.github/workflows/ci.yml` performs Go tests/vet, frontend build/tests, Compose validation, and production Docker image build validation on GitHub runners.
2. `.github/workflows/release-images.yml` builds and pushes immutable GHCR images tagged `sha-<commit>` after successful main CI or explicit dispatch.
3. `.github/workflows/deploy-production.yml` accepts a verified main SHA and remotely invokes the production release script.
4. The production release script pulls immutable images, runs migration, starts services, and verifies health/readiness rather than rebuilding application images on the host.

Agenticform should model these as project runbooks instead of hard-coding Richmod behavior into the control plane.

A typical Richmod production runbook can therefore be expressed as:

```json
[
  {
    "key": "release-images",
    "name": "Wait for release images",
    "type": "GITHUB_WORKFLOW",
    "timeoutSeconds": 1800,
    "config": {
      "mode": "WAIT",
      "repository": "raufimusaddiq/richmod",
      "workflow": "release-images.yml",
      "ref": "main",
      "headSha": "${param:sha}"
    }
  },
  {
    "key": "deploy",
    "name": "Deploy production",
    "type": "GITHUB_WORKFLOW",
    "timeoutSeconds": 1800,
    "config": {
      "mode": "DISPATCH",
      "repository": "raufimusaddiq/richmod",
      "workflow": "deploy-production.yml",
      "ref": "main",
      "inputs": {
        "sha": "${param:sha}"
      }
    }
  },
  {
    "key": "health",
    "name": "Verify health",
    "type": "SERVICE_CHECK",
    "timeoutSeconds": 30,
    "config": {
      "service": "web",
      "probe": "health"
    }
  },
  {
    "key": "readiness",
    "name": "Verify readiness",
    "type": "SERVICE_CHECK",
    "timeoutSeconds": 30,
    "config": {
      "service": "web",
      "probe": "readiness"
    }
  }
]
```

The runbook action remains `PRODUCTION_DEPLOY` and environment remains `production`, so the deterministic policy engine still requires the configured human boundary before dispatching deployment.

## Disk-space model

Agenticform should avoid becoming a second CI worker by default.

For coding projects:

- coding worktrees are disposable;
- the default Operational Agent uses the shared project workspace, not another worktree;
- local targeted tests are allowed when useful;
- full builds and production Docker builds should prefer remote CI;
- release artifacts/images live in the configured registry;
- production hosts pull immutable images;
- cleanup can remove merged/terminal coding-agent worktrees and old local release images after the configured retention boundary.

This preserves agent autonomy while keeping the control-plane host small and predictable.
