# Agenticform Platform & SaaS PRD

Status: Proposed  
Baseline: `main` after PR #14 — Tech Debt Closure and Sprint 13 / PR #13 — Operational Intelligence  
Baseline commit: `76e5afa5803917c9db766b6ba54bdf50fce35b58`  
Reserved public endpoint: `https://agentic.investdx.biz.id`  
Target outcome: production-grade Agenticform Self-Hosted plus Agenticform Cloud with customer-owned execution nodes by default.

## 1. Executive summary

This PRD starts from the current merged architecture, not from Sprint 12.

The completed baseline is:

```text
Sprint 12 — Distributed Recovery & Runtime Reliability
        │
        ▼
PR #14 — Tech Debt Closure
        │ merged
        ▼
Sprint 13 / PR #13 — Operational Intelligence
        │ merged
        ▼
Platform / SaaS roadmap
```

PR #14 closed accumulated architecture and security debt, including payload-bound one-shot policy preauthorization, execution-node protocol compatibility fencing, durable message processing/completion acknowledgement, persisted capability profiles and enforcement, task dependency DAGs, approved-root project discovery, SSE live control-plane events, explicit cross-project communication rules, deterministic agent stop lifecycle, conversation/reply UI, and production control-plane/web container packaging.

Sprint 13 added durable operational signals, deterministic signal-to-incident correlation, incident lifecycle/evidence, node-aware Operational Agent wake-up, operation-failure and node-loss signal production, service-health monitoring/recovery evidence, native incident tooling, incident/signal UI, and the final V14 migration on top of PR #14's V13 migration.

The next phase is therefore productization rather than another rewrite of the execution engine.

The remaining work is organized into five stages:

```text
runtime abstraction
        │
identity / tenancy
        │
product packaging
        │
cloud service
        │
production SaaS hardening
```

The ordering is intentional. Runtime abstraction prevents the product/domain model from remaining permanently Codex-specific. Identity and tenancy create the security boundary before multiple organizations share one control plane. Product packaging turns the already-containerized system into a supported self-hosted product. Cloud service then hosts the same core product. SaaS hardening closes isolation, reliability, abuse, observability, operational, and release gaps before v1 GA.

`https://agentic.investdx.biz.id` is reserved as the future public Agenticform endpoint. It is not an existing deployment or migration source.

## 2. Product thesis

Agenticform does not compete with Codex, Claude Code, Gemini CLI, or similar agent runtimes on model intelligence.

Agenticform is the durable control plane above them:

```text
                         Agenticform

                 organization / projects
                          │
                  tasks / dependency DAG
                          │
             messaging / conversations
                          │
                policy / approvals
                          │
               incidents / operations
                          │
                 HITL / HOTL / audit
                          │
                  runtime scheduler
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
       Codex         Claude Code       other runtime
          │               │               │
          └───────────────┼───────────────┘
                          │
                   execution nodes
```

Product promise:

> Turn customer-owned machines into a governed, durable, observable software-engineering agent organization without requiring Agenticform Cloud to own the customer's source-code execution environment or runtime credentials.

### Deployment modes

1. **Agenticform Self-Hosted** — customer operates control plane, database, and execution fleet.
2. **Agenticform Cloud** — Agenticform operates the control plane; customer-owned outbound-only execution nodes remain the default execution model.

Managed execution may be added later and is not required for v1.

## 3. Merged baseline carried forward

The roadmap assumes these capabilities already exist and must be preserved:

- project registry and approved-root project discovery;
- durable agent lifecycle and deterministic stop lifecycle;
- durable tasks with dependency DAG and dependency-aware dispatch;
- persisted agent capability profiles and enforcement;
- direct, multicast, role, group, project-broadcast, and governed cross-project communication;
- durable message delivery plus processing/completion acknowledgement;
- conversation/reply UI;
- isolated Git worktrees and fail-closed cleanup;
- HITL and HOTL operating modes;
- deterministic `ALLOW / REQUIRE_HUMAN / DENY` policy rules;
- payload-bound one-shot policy preauthorization;
- one system-managed Operational Agent per project;
- immutable policy-gated operational runbooks;
- durable GitHub Actions dispatch/wait/reconciliation;
- outbound-only execution-node enrollment;
- Ed25519 node identity, replay protection, trust/capacity placement, and protocol compatibility fencing;
- runtime generation fencing;
- effectively-once node effects with ambiguous-side-effect fail-closed behavior;
- restart-safe remote approvals;
- node-loss rehydration for eligible Git-backed agents;
- GitHub App short-lived repository credential brokering;
- SSE live control-plane events;
- durable operational signals with dedupe/occurrence aggregation;
- deterministic signal-to-incident correlation;
- durable incident lifecycle and evidence;
- node-aware Operational Agent auto-wake;
- operation-failure, node-loss, and service-health signal production;
- incident/recovery evidence and Operations UI;
- production container builds for control plane and web.

These are existing primitives. The roadmap below must extend them rather than implement parallel replacements.

## 4. Product principles

### 4.1 One core product

Cloud and Self-Hosted use the same domain semantics and core services. Deployment-specific adapters and optional commercial modules may differ, but Agent, Task, Runtime, Node, Message, Incident, Policy, Approval, and Operation behavior must remain shared.

### 4.2 Runtime credentials stay at the execution boundary by default

For customer-owned nodes, Agenticform Cloud stores runtime capability/profile metadata and health, not the actual Codex/Claude/Gemini credential.

### 4.3 Organization is the tenant isolation boundary

Once tenancy exists, every customer-owned resource must have an explicit or provable organization ownership path. Knowing a UUID must never be sufficient to access another organization's project, task, agent, conversation, message, signal, incident, approval, node, operation, runbook, credential, event, or audit row.

### 4.4 Identity classes stay separate

```text
human user identity
      !=
organization membership
      !=
execution-node identity
      !=
agent runtime credential
      !=
Git/provider credential
```

### 4.5 Preserve existing safety semantics

Runtime abstraction and SaaS work must preserve:

- runtime-generation fencing;
- node protocol compatibility fencing;
- durable message completion semantics;
- approval durability;
- ambiguous-side-effect fail-closed behavior;
- policy re-evaluation at governed boundaries;
- deterministic cleanup rules.

### 4.6 Public-source compatible security

Security must assume the complete core source can be read by an attacker. Secrets, customer data, production credentials, and environment-specific sensitive infrastructure state must remain outside the public source tree.

A permissive license such as MIT or Apache-2.0 is acceptable. Licensing is not a security boundary.

## 5. Stage 1 — Runtime abstraction

### Goal

Make Codex the first runtime adapter rather than a core domain assumption.

### Required domain changes

Replace core-level Codex identity with runtime-neutral state:

```text
Agent
- id
- projectId
- name
- responsibility
- runtimeType
- runtimeProfileId
- runtimeSessionId       // opaque to core domain
- runtimeGeneration
- workspace...
- status...
```

The core domain must not require `codexThreadId`.

### Runtime SPI

Conceptual contract:

```java
public interface AgentRuntime {
    RuntimeType type();
    RuntimeCapabilities capabilities();
    RuntimeSession start(RuntimeStartRequest request);
    RuntimeTurn submit(RuntimeSessionId sessionId, RuntimeInput input);
    void steer(RuntimeSessionId sessionId, RuntimeTurnId turnId, RuntimeInput input);
    void interrupt(RuntimeSessionId sessionId, RuntimeTurnId turnId);
    RuntimeSnapshot inspect(RuntimeSessionId sessionId);
    void stop(RuntimeSessionId sessionId);
}
```

The exact API may differ, but project/task/message/policy/incident/operation code must not depend directly on Codex protocol classes.

### Codex adapter

The existing Codex behavior becomes `CodexAgentRuntime` or equivalent and remains responsible for App Server transport, thread/turn mapping, event translation, dynamic Agenticform tools, approvals, Codex queue semantics, and reconnect/reconciliation.

### Runtime-neutral node capability advertisement

Execution nodes advertise structured runtime inventory, for example:

```json
{
  "runtimes": {
    "CODEX": {
      "available": true,
      "authenticated": true,
      "version": "0.154.0"
    }
  }
}
```

Reuse the capability-profile scheduler introduced in PR #14. Runtime requirements, agent capability profiles, trust, capacity, protocol compatibility, and placement constraints must compose into one deterministic scheduling decision.

### Credential profile

Introduce runtime credential/profile references without requiring cloud custody of credentials. A node-local profile stores only metadata in the control plane:

```text
profile: codex-personal
runtime: CODEX
storage: NODE_LOCAL
node scope: node-123
status: HEALTHY
```

### Migration

Existing Codex agents migrate in place:

```text
runtimeType = CODEX
runtimeSessionId = previous codexThreadId
```

No destructive reset of agents, tasks, dependencies, messages, incidents, approvals, operations, or recovery state is acceptable.

### Exit criteria

- core orchestration no longer imports Codex protocol types;
- existing Codex behavior passes regression tests;
- task dependency/capability scheduling remains intact;
- runtime IDs are opaque outside adapters;
- remote recovery/fencing works through the runtime abstraction;
- adding a second runtime does not require redesigning Agent or Task schema.

A second production runtime is not required to complete this stage; a fake/test runtime may prove abstraction correctness.

## 6. Stage 2 — Identity and tenancy

### Goal

Replace the single-owner admin-token model with explicit users, organizations, memberships, roles, sessions, and tenant-scoped resources while keeping self-hosted bootstrap simple.

### Core hierarchy

```text
User
  └── OrganizationMembership
         └── Organization
               ├── Projects
               ├── Agents
               ├── Tasks / dependencies
               ├── Conversations / messages
               ├── Execution Nodes
               ├── Policies / approvals
               ├── Signals / incidents
               ├── Operations
               ├── Credential Profiles
               └── Audit Events
```

### Minimum roles

- `OWNER`
- `ADMIN`
- `DEVELOPER`
- `VIEWER`

RBAC determines who may request or decide. The deterministic policy engine continues to determine whether an action is `ALLOW`, `REQUIRE_HUMAN`, or `DENY`.

### Authentication

Required architecture:

- secure first-owner bootstrap;
- browser sessions or short-lived access tokens with revocation/expiration;
- provider boundary suitable for local auth and/or OIDC;
- API/service identities separate from human sessions;
- logout, session revocation, and account recovery;
- appropriate CSRF/session protections.

`AGENTICFORM_ADMIN_TOKEN` may remain as a narrowly scoped emergency/bootstrap compatibility mechanism for Self-Hosted, but not as normal Cloud authorization.

### Tenant-safe nodes and integrations

Execution nodes belong to exactly one organization for v1. Organization ownership is resolved from server-side node enrollment state, never from a caller-supplied organization id.

GitHub and future provider integrations are organization-scoped. Credential brokering must verify organization + node + project + runtime generation + registered repository.

### Migration

Existing installations migrate into a generated default organization without recreating projects, agents, nodes, policies, incidents, operations, or audit history.

### Isolation tests

Automated negative tests must prove Organization A cannot access Organization B across REST, SSE/events, nodes, background jobs, credential broker, conversations/messages, incidents/signals, approvals, operations, audit, and provider integrations.

### Exit criteria

- all customer resources have defined organization ownership;
- normal UI/API access uses authenticated users and memberships;
- server-side RBAC is enforced;
- nodes and provider integrations are tenant-scoped;
- existing installs migrate safely;
- adversarial cross-tenant tests pass.

## 7. Stage 3 — Product packaging

### Goal

Turn the current production containers into a supported Self-Hosted product.

PR #14 already introduced production container packaging; this stage productizes installation, configuration, lifecycle, and release contracts rather than recreating the images.

### Required release artifacts

Each supported release provides:

- immutable/versioned control-plane image(s);
- immutable/versioned execution-node image;
- supported Docker Compose stack or documented equivalent;
- `.env.example` with no secrets;
- startup/config validation;
- database migration notes;
- upgrade instructions;
- backup/restore procedure;
- rollback boundaries;
- release notes and compatibility matrix.

### First-run UX

```text
configure public URL
      ↓
start supported stack
      ↓
open browser
      ↓
bootstrap first owner
      ↓
create/select organization
      ↓
register project / enroll node
      ↓
run first agent
```

No manual DB editing is acceptable.

### Operational health

Packaging exposes liveness, readiness, DB migration state, build/version metadata, and execution-node compatibility visibility.

### Reserved endpoint

The first deployment to `https://agentic.investdx.biz.id` must use the same supported packaging and upgrade path documented for external Self-Hosted users, not one-off developer startup commands.

### Exit criteria

- clean machine installs without building source;
- one documented command/path brings up a supported stack;
- browser-driven owner bootstrap works;
- upgrade, backup, restore, and rollback boundaries are tested;
- version compatibility is enforced or explicitly negotiated.

## 8. Stage 4 — Cloud service

### Goal

Operate the same Agenticform core as a hosted multi-tenant control plane while keeping execution on customer-owned nodes by default.

### Topology

```text
                    Internet
                       │
                       ▼
               Agenticform Cloud
         ┌────────────────────────────┐
         │ identity / organizations   │
         │ orchestration / policy     │
         │ incidents / operations     │
         │ API / UI / SSE             │
         │ audit / usage metadata     │
         └─────────────┬──────────────┘
                       │ outbound HTTPS from customer
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  customer node A customer node B customer node C
       runtime          runtime          runtime
       source           source           source
       credentials      credentials      credentials
```

### Public endpoint

Initial hosted endpoint: `https://agentic.investdx.biz.id`, unless intentionally superseded before launch.

Production routing must terminate TLS, enforce HTTPS, and preserve signed node-request semantics without depending on source-IP trust.

### Onboarding

```text
sign in
  ↓
create organization
  ↓
connect/register project
  ↓
enroll execution node
  ↓
node advertises runtimes
  ↓
spawn agent
```

Organization invitations must work before GA.

### BYO execution

BYO nodes are first-class in v1. Agenticform Cloud does not require inbound SSH or an inbound worker port.

Runtime credentials remain node-local by default.

### Entitlements

Cloud must have server-side entitlement primitives even if billing is not enabled initially. Candidate limits:

- member count;
- projects;
- execution nodes;
- concurrent agents;
- history/audit retention;
- advanced integrations/features.

### Platform-admin boundary

Internal platform operators are separate from customer organization owners. Support access must be explicit, least-privilege, and auditable. Silent tenant impersonation is not acceptable.

### Exit criteria

- multiple independent organizations use one hosted control plane safely;
- each organization enrolls its own nodes;
- node-local runtime credentials work;
- invitations/RBAC and tenant-scoped GitHub integration work;
- entitlements are represented and enforced;
- Self-Hosted and Cloud use the same core execution semantics.

## 9. Stage 5 — Production SaaS hardening

### Goal

Move from functional hosted beta to a service safe for untrusted tenants, noisy workloads, failures, incidents, and continuous upgrades.

### Tenant isolation review

Review and adversarially test:

- REST APIs;
- SSE/event streams;
- background schedulers;
- conversations/messages;
- incidents/signals;
- approvals;
- node command queues;
- runtime events;
- credential broker;
- webhook correlation;
- operational runbooks;
- audit queries;
- caches;
- telemetry and support tooling.

### Rate limits and quotas

Introduce limits at appropriate scopes:

```text
IP / anonymous
user
organization
execution node
runtime/session
provider integration
```

Protect high-cost paths such as agent spawn, task dispatch, fanout, enrollment creation, credential issuance, reconciliation, and polling without breaking durable long-running jobs.

### Noisy-neighbor protection

Bound worker pools, queue consumption, fanout, event retention, concurrent operations, reconciliation loops, database query sizes, and response payloads so one organization cannot trivially starve others.

### Usage metering

Persist dimensions Agenticform can measure reliably: active/concurrent agents, nodes, task/runtime activity, operations, and selected storage/history dimensions.

Third-party model spend is not assumed to be perfectly measurable when credentials and provider billing remain customer-owned.

### Auditability

Security-relevant audit rows include organization, actor type/id, action, target, result, timestamp, policy/RBAC decision, and correlation identifiers. Secrets and credential payloads must never be persisted into audit logs.

### Observability and SLOs

Production observability includes API latency/errors, scheduler/queue state, node health/command latency, runtime start/failure/recovery, approval latency, incidents, operation state, database health, structured logs, and useful tracing.

Define initial SLOs and alerts around user-impacting symptoms rather than every internal warning.

### Security controls

Before GA:

- repository secret scanning;
- dependency/container vulnerability scanning;
- immutable image provenance/digest pinning;
- secure headers/TLS;
- session/token rotation and revocation;
- webhook signature enforcement;
- node key revocation/re-enrollment;
- least-privilege runtime/database identities;
- protected/encrypted backups;
- vulnerability reporting/security policy.

### Data lifecycle

Define retention/deletion for users, organizations, projects, messages/events, incidents/signals, operation evidence, audit logs, nodes, and integrations.

Organization deletion must deterministically revoke active nodes/sessions and complete asynchronously if necessary.

### Disaster recovery

Test DB backup/restore, application instance loss, safe restart/reconciliation, credential/key rotation after compromise, and node reconnection after control-plane recovery.

### Deployment safety

Production deploys use immutable images, migration validation, readiness gates, controlled rollout, documented rollback decisions, and a compatibility policy for older node versions.

### Abuse/support controls

Platform admins can suspend users/orgs, revoke sessions/tokens, revoke nodes, stop new scheduling for an organization, and inspect service health without exposing unrelated tenants. High-impact actions are audited.

### Exit criteria

- automated/manual tenant isolation review has no known critical blocker;
- quotas/rate limits prevent trivial exhaustion;
- observability and alerts cover critical paths;
- backup/restore is exercised;
- security scanning/provenance is in CI/CD;
- suspension/revocation/deletion flows exist;
- upgrades are repeatable and rollback boundaries are understood;
- production-readiness review passes.

## 10. Sprint mapping

The platform/product phase starts after the merged Sprint 13 baseline.

| Sprint | Product stage | Primary outcome |
|---|---|---|
| 13 | Operational Intelligence | **Merged baseline** |
| 14 | Runtime abstraction | Codex becomes first adapter; core domain becomes runtime-neutral |
| 15 | Identity & tenancy foundation | users, organizations, memberships, tenant ownership, migration |
| 16 | Tenant authorization & integration isolation | RBAC, tenant-safe nodes/GitHub/events/background jobs, adversarial tests |
| 17 | Product packaging | supported Self-Hosted release, bootstrap, upgrades, backup/restore |
| 18 | Cloud service foundation | hosted multi-tenant control plane, onboarding, BYO nodes, public endpoint |
| 19 | Cloud product controls | invitations, entitlements, usage foundation, platform-admin boundary |
| 20 | SaaS hardening I | quotas, rate limits, noisy-neighbor controls, tenant-isolation review |
| 21 | SaaS hardening II / v1 readiness | observability, DR, security/release hardening, GA review |

Sprint boundaries may shift based on implementation evidence, but stage ordering must not be casually reordered. Cloud cannot precede tenant isolation, and additional runtime providers must not block runtime-abstraction completion.

## 11. v1 definition of done

### Self-Hosted

A user can install immutable published artifacts, bootstrap an owner, create/use an organization, register repositories, enroll nodes, detect runtimes, create agents, dispatch dependency-aware tasks, use agent communication, use HITL/HOTL/policy, observe incidents/operations, recover after supported restarts/failures, upgrade, backup, and restore using documented procedures.

### Agenticform Cloud

A user can access the hosted endpoint, authenticate, create/join an organization, invite members, connect tenant-scoped GitHub resources, enroll customer-owned nodes without inbound ports, keep runtime credentials node-local by default, execute the same agent/task/policy/incident/operation lifecycle as Self-Hosted, view usage/limits/audit history, and remain isolated from every other organization.

### Reliability boundary

A control-plane or node restart must not cause unsafe replay, cross-tenant routing, duplicate irreversible effects, loss of durable approvals/messages/incidents, or silent compatibility bypass.

## 12. Deferred beyond v1

These must not delay v1 unless implementation proves them prerequisite:

- Agenticform-hosted managed execution fleet;
- runtime/provider marketplace;
- large catalog of runtime adapters;
- Kubernetes operator;
- cross-region active-active control plane;
- complex third-party LLM rebilling;
- full enterprise SCIM/SAML feature set;
- arbitrary workflow-language product;
- public plugin marketplace;
- mobile applications.

## 13. Architecture decisions

Unless superseded by an ADR:

1. Agenticform remains one core product for Cloud and Self-Hosted.
2. Codex becomes an adapter behind a runtime abstraction.
3. Existing capability profiles are reused by runtime-neutral scheduling.
4. Organizations are the primary customer isolation boundary.
5. Customer-owned execution nodes are the default Cloud execution model.
6. Runtime credentials remain node-local by default.
7. Human, node, runtime, and provider identities remain distinct.
8. Existing fencing, durable messaging, approvals, incidents, and fail-closed semantics are preserved.
9. Product packaging precedes Cloud launch.
10. Security assumes core source is public.
11. MIT or Apache-2.0 are acceptable licensing options.
12. `https://agentic.investdx.biz.id` is reserved for the future hosted Agenticform service and must use the supported production deployment path.
