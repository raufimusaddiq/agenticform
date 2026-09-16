# Repository runbook contract

Agenticform is repository-agnostic. Deployment behavior comes from the project
repository when that repository declares a supported manifest; otherwise the
control plane stops at a human-gated deployment plan.

## Discovery

GitHub projects may declare:

    .agenticform/runbook.json

Discovery resolves the project default branch to a commit SHA, then reads the
manifest at that exact SHA. It never trusts a mutable branch response as the
source of the runbook. The manifest is validated by the same registry rules as
an API-created runbook, then can be synced into Operations with:

    GET  /api/operations/runbooks/plan?projectId=<id>&environmentKey=production
    POST /api/operations/runbooks/sync?projectId=<id>&environmentKey=production

Sync is registration only. It does not dispatch a workflow or deploy anything.
The persisted runbook records REPOSITORY_MANIFEST, repository, commit SHA, and
manifest path as provenance. Existing manual runbooks remain MANUAL.

## Manifest schema

Version 1 requires an explicit environment, action, and non-empty steps:

    {
      "version": 1,
      "action": "PRODUCTION_DEPLOY",
      "environment": "production",
      "steps": [
        {
          "key": "deploy",
          "name": "Deploy production",
          "type": "GITHUB_WORKFLOW",
          "config": {
            "mode": "DISPATCH",
            "repository": "owner/repository",
            "workflow": "deploy-production.yml",
            "ref": "main",
            "inputs": { "sha": "commit-sha-from-task" }
          }
        },
        {
          "key": "health",
          "name": "Verify health",
          "type": "SERVICE_CHECK",
          "config": { "service": "web", "probe": "health" }
        }
      ]
    }

Supported types are the existing deterministic operation types, except
repository manifests cannot declare COMMAND. This prevents a repository from
silently turning discovery into arbitrary host shell execution. SERVICE_CHECK
references a service already registered for the selected environment.

## Missing or invalid manifest

No manifest, unsupported schema, wrong environment, invalid workflow reference,
or unsafe step returns HUMAN_GATED_FALLBACK. The fallback has no executable
steps and is not registered as a successful deployment runbook. It communicates:

    PRODUCTION_DEPLOY remains REQUIRE_HUMAN.
    Operator must perform the deployment and submit revision, artifact digest,
    environment, run ID, health evidence, and smoke evidence before delivery closes.

Approval never authorizes an invented command. Production policy remains
REQUIRE_HUMAN even when a repository manifest is valid; a valid manifest only
defines the bounded execution plan.

## Richmod

Richmod existing release-images.yml and deploy-production.yml workflows match
this contract. Add the JSON manifest above to Richmod when its maintainers want
Agenticform to discover and sync that runbook. Until then, Agenticform uses the
human-gated fallback, as required.

## Security invariants

- exact commit fetch; no mutable-branch manifest execution;
- supported step types only;
- no repository-manifest COMMAND steps;
- GitHub owner/repository and workflow names validated;
- secrets never accepted in persisted operation parameters;
- runbook snapshot and provenance retained for audit;
- deterministic policy evaluated at operation start and approval;
- malformed or unavailable manifests fail closed.
