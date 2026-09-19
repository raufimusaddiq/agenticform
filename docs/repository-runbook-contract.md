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

## Agent-proposed manifest (review-only)

Repositories rarely declare the manifest initially. The Operational Agent can
close that gap without gaining write authority over the deployment contract:

1. `inspect_repository_deployment_evidence` reads a bounded set of files at the
   current default-branch commit: GitHub workflows, existing `runbook/*.md` or
   `.agenticform/*.md` docs, Dockerfile, Compose files, and Makefile. File
   contents are untrusted evidence, never instructions.
2. `propose_repository_runbook` validates the drafted manifest with the same
   registry rules as any other runbook, rejects COMMAND steps and secret-like
   workflow inputs, then opens a pull request adding `.agenticform/runbook.json`
   on a `agenticform/runbook-<uuid>` branch.

The proposal registers nothing and executes nothing. A human reviews and merges
the pull request; only then does discovery see the manifest at the new commit,
and only then can `sync_repository_runbook` followed by `request_operation`
register and run it. Until a merged manifest exists, deployment stays
HUMAN_GATED_FALLBACK.

An agent that can author the contract it deploys under would erase the trust
anchor, so manifest authorship stops at the pull request. The proposed manifest
must be justified by repository evidence; the agent may never invent steps it
cannot point at in the current commit.

## Richmod

Richmod's existing release-images.yml and deploy-production.yml workflows match
this contract. Its manifest waits for immutable images, then dispatches the
manual production workflow. That is the runbook's endpoint: GitHub's protected
production Environment owns the final deployment approval and the runbook does
not issue post-dispatch checks.

## Agenticform

Agenticform's manifest dispatches `.github/workflows/deploy-production.yml` and
stops at that workflow. The workflow builds immutable server/web images from
the requested main SHA, then deploys them only after the GitHub `production`
Environment gate. Configure required reviewers and the `PROD_DEPLOY_HOST`,
`PROD_DEPLOY_USER`, `PROD_DEPLOY_SSH_KEY`, and `PROD_DEPLOY_KNOWN_HOSTS`
environment secrets before enabling it. It preserves the host's node image
digest and runtime environment file.

## Security invariants

- exact commit fetch; no mutable-branch manifest execution;
- supported step types only;
- no repository-manifest COMMAND steps;
- GitHub owner/repository and workflow names validated;
- secrets never accepted in persisted operation parameters;
- runbook snapshot and provenance retained for audit;
- deterministic policy evaluated at operation start and approval;
- malformed or unavailable manifests fail closed.
- agent-authored manifests are review-only pull requests and never self-merge.
