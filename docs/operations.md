# Agenticform Operational Contracts

## Purpose

Agenticform operational runbooks are safe actuators for agent intent. They do not replace agentic reasoning, coding, debugging, architecture work, or collaboration.

The boundary is:

```text
Codex agent
  reasons / edits / reviews / chooses intent
        |
        v
Agenticform operation
  snapshots / policy-checks / executes / verifies / audits
```

For coding tasks, Agenticform is intentionally **remote-CI-first**. Expensive full-suite validation, production image builds, release publication, and deployment should normally run on GitHub Actions when a project exposes suitable runbooks. Local worktrees remain temporary coding workspaces, not CI build hosts.

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

Agents receive native Agenticform tools:

- `list_runbooks`
- `request_operation`
- `get_operation_status`

A registered runbook evaluates deterministic policy as part of `request_operation`; agents should not request a separate policy approval for the same operation.

This lets an agent choose the right execution path without making authorization probabilistic.

## Recommended coding lifecycle

```text
Agent worktree
  |
  | edit / targeted test / commit
  v
Push branch / PR
  |
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
Agenticform production operation
  | deterministic policy gate
  | dispatch deploy workflow
  v
Production host
  | pull immutable image
  | migrate / restart
  | health + readiness verification
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

- local worktrees are disposable;
- local targeted tests are allowed when useful;
- full builds and production Docker builds should prefer remote CI;
- release artifacts/images live in the configured registry;
- production hosts pull immutable images;
- cleanup can remove merged/terminal agent worktrees and old local release images after the configured retention boundary.

This preserves agent autonomy while keeping the control-plane host small and predictable.
