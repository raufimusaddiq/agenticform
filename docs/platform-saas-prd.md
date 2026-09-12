# Agenticform Platform & SaaS PRD

Status: Proposed  
Activation baseline: `main` after PR #14 — Tech Debt Closure is merged, then Sprint 13 / PR #13 — Operational Intelligence is rebased on that `main` and merged  
Reserved public endpoint: `https://agentic.investdx.biz.id`  
Target outcome: production-grade Agenticform Self-Hosted plus Agenticform Cloud with customer-owned execution nodes by default.

## 1. Executive summary

This PRD is intentionally sequenced after the two currently open foundation PRs:

```text
Sprint 12 — Distributed Recovery & Runtime Reliability
        │
        ▼
PR #14 — Tech Debt Closure
        │
        │ merge first
        ▼
PR #13 — Sprint 13 Operational Intelligence
        │ rebase onto main, then merge
        ▼
Platform / SaaS roadmap in this PRD
```

PR #14 closes accumulated architecture and security debt before higher autonomy and platformization. Its intended merged baseline includes payload-bound one-shot policy preauthorization, execution-node protocol compatibility fencing, durable message processing/completion acknowledgement, persisted capability profiles and enforcement, task dependency DAGs, project discovery, SSE live control-plane events, explicit cross-project communication rules, deterministic agent stop lifecycle, conversation/reply UI, and production container packaging for the control plane and web.

Sprint 13 then adds the operational-intelligence layer on top of that cleaned baseline: durable operational signals, deterministic signal-to-incident correlation, incident lifecycle/evidence, node-aware Operational Agent wake-up, operation-failure and node-loss signal production, service-health monitoring/recovery evidence, incident idempotency, native incident tooling, and Operations UI visibility.

After those two PRs merge, Agenticform already has the hard execution-plane and operational foundation required for a serious agent control plane:

- durable projects, agents, tasks, dependency-aware dispatch, communication, approvals, policy, and operations;
- persisted agent capability profiles and capability enforcement;
- isolated coding workspaces and deterministic stop/cleanup lifecycle;
- durable message delivery plus processing/completion acknowledgement;
- direct, multicast, role, group, project-broadcast, and explicitly governed cross-project communication;
- one system-managed Operational Agent per project;
- deterministic `ALLOW / REQUIRE_HUMAN / DENY` policy enforcement with payload-bound one-shot authorization;
- HITL and HOTL operating modes;
- outbound-only distributed execution nodes;
- Ed25519 node identity, replay protection, protocol compatibility fencing, and trust/capability/capacity-aware placement;
- runtime-generation fencing;
- durable node effects and restart-safe remote approvals;
- node-loss rehydration for eligible Git-backed agents;
- GitHub App based short-lived repository credentials;
- durable GitHub Actions waits and operational recovery;
- durable operational signals and incidents with deterministic correlation;
- node-aware Operational Agent auto-wake and incident response;
- live SSE control-plane events and conversation/reply UI;
- production container packaging for control plane and web.

The next product phase is therefore not another rewrite of agent execution or operations. The objective is to turn this distributed Codex-oriented control plane into a provider-neutral product that can operate in two first-class deployment models:

1. **Agenticform Self-Hosted** — customer operates the complete control plane and execution fleet.
2. **Agenticform Cloud** — Agenticform operates the control plane while execution remains on customer-enrolled nodes by default.

The remaining work is organized into five consecutive product stages:

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

These stages are intentionally ordered. Runtime abstraction prevents SaaS/domain state from becoming permanently Codex-specific. Identity and tenancy establish the security boundary before hosting multiple organizations. Packaging turns the already-containerized product into a supported self-hosted release. Cloud service then hosts that same product without changing execution semantics. SaaS hardening closes reliability, abuse, observability, isolation, and operational gaps before v1 general availability.

`https://agentic.investdx.biz.id` is reserved as the future public Agenticform endpoint. It is not treated as an existing production deployment or migration source. The first deployment to that domain must use the supported packaging, configuration, migrations, and operational procedures defined by this roadmap.

## 2. Product thesis

Agenticform is not intended to compete with Codex, Claude Code, Gemini CLI, or other coding-agent runtimes on model intelligence.

Agenticform is the durable operating layer above them:

```text
                         Agenticform

                 organization / projects
                          │
                  tasks / delegation
                          │
               communication / policy
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

The product promise is:

> Turn customer-owned machines into a governed, durable, observable software-engineering agent organization without requiring Agenticform Cloud to own the customer's source-code execution environment or agent credentials.

For the hosted product, the preferred boundary is:

```text
Agenticform Cloud
    owns:
      - organization and membership state
      - project/agent/task orchestration
      - scheduling metadata
      - policy and approval state
      - operational signal/incident state
      - audit and observability metadata

Customer execution node
    owns by default:
      - checked-out source code
      - agent runtime process
      - runtime credentials
      - local build/runtime dependencies
      - access to customer-private networks
```

Managed execution may be added later, but managed compute is explicitly not a v1 requirement.

## 3. Activation baseline

This PRD is not a green-field design and must not be implemented against Sprint 12 alone.

The expected activation sequence is:

1. merge PR #14 (`chore: close accumulated architecture and security debt`);
2. rebase PR #13 (`feat: add operational intelligence and incident response`) onto the resulting `main`;
3. resolve its migration/version ordering after the PR #14 migrations;
4. finish PR #13's remaining verification/UI/docs scope and merge it;
5. rebase this PR on that resulting `main` before merge if required.

If PR #13 or PR #14 materially changes before merge, this PRD must follow the final merged behavior rather than preserve assumptions from an older draft.

### 3.1 Capabilities assumed present after PR #14 + Sprint 13

The platform roadmap assumes all of the following already exist and are retained:

- project registry and approved-root project discovery;
- agent lifecycle, deterministic stop lifecycle, durable tasks, and task dependency DAG;
- persisted capability profiles and capability-aware dispatch;
- direct/multicast/role/group/project-broadcast communication;
- explicit cross-project communication rules;
- durable message processing/completion acknowledgement;
- conversation/reply UI;
- isolated Git worktrees and fail-closed cleanup;
- HITL / HOTL modes;
- persisted deterministic policy rules;
- payload-bound one-shot policy preauthorization;
- project-scoped Operational Agents and immutable operational runbooks;
- durable GitHub Actions dispatch/wait/reconciliation;
- execution-node enrollment and signed device authentication;
- execution-node protocol compatibility fencing;
- capability/trust/capacity-aware node placement;
- remote Codex execution over node-local stdio;
- runtime generation fencing;
- durable remote approvals and node command effects;
- restart and node-loss recovery;
- GitHub App credential brokering for private repositories;
- SSE live control-plane events;
- operational signals with fingerprint dedupe/occurrence aggregation;
- deterministic signal-to-incident correlation;
- durable incident lifecycle and evidence;
- node-aware Operational Agent auto-wake;
- operation-failure, node-loss, and service-health signal production;
- incident/recovery evidence and incident UI;
- production container packaging for control plane and web.

### 3.2 Remaining product gaps

The main gaps after that baseline are above the execution and incident engines:

- core domain state still exposes Codex-specific concepts;
- runtime capability advertisement is still Codex-oriented rather than provider-neutral;
- operator identity is a single admin bearer token rather than users and organizations;
- customer resources are not tenant-scoped;
- production containers exist, but there is not yet a polished supported self-hosted release contract covering bootstrap, upgrades, backup/restore, configuration, and immutable published artifacts;
- there is no hosted multi-tenant control-plane product boundary;
- there are no SaaS-grade quota, abuse, metering, platform-admin, tenant-isolation, and production service controls.

## 4. Product principles and non-negotiable invariants

### 4.1 One core product

Cloud and self-hosted must not become separate forks.

```text
                     Agenticform Core
                           │
                  same domain semantics
                           │
            ┌──────────────┴──────────────┐
            ▼                             ▼
       Self-Hosted                  Agenticform Cloud
```

Deployment-specific adapters and commercial modules may differ, but task, agent, runtime, node, message, incident, policy, and operational semantics must remain shared.

### 4.2 Runtime credentials stay at the execution boundary by default

Agenticform Cloud must not require customer Codex/Claude/Gemini credentials to be stored in the cloud control plane when a runtime executes on a customer node.

The node reports runtime capability and authentication health, not the credential itself.

### 4.3 Tenant identity is an authorization boundary

Once tenancy exists, an organization identifier is not decorative metadata. Every tenant-owned resource and every access path must be organization-scoped server-side.

A caller must never gain access to another organization by knowing or guessing a project, task, agent, approval, node, message, conversation, incident, signal, operation, runbook, or event identifier.

### 4.4 Human, machine, runtime, and provider identities are distinct

The platform must model these separately:

```text
human user identity
      !=
organization membership
      !=
execution-node identity
      !=
agent runtime credential
      !=
GitHub/provider credential
```

No one credential should implicitly confer all five authorities.

### 4.5 Preserve fail-closed recovery and compatibility semantics

The existing principle remains: if Agenticform cannot prove that replay, cleanup, ownership, authorization, compatibility, or continuation is safe, it must stop and require reconciliation rather than guess.

Runtime abstraction, tenancy, and Cloud must not bypass runtime-generation fencing, node protocol compatibility fencing, durable message completion semantics, or ambiguous-side-effect handling.

### 4.6 Operational intelligence remains a core primitive

Signals and incidents introduced by Sprint 13 are not a temporary operational add-on. Cloud observability and SaaS support controls must build on the same durable incident model where appropriate rather than introducing a parallel incompatible incident engine.

### 4.7 Public-source compatible security

Security must assume an attacker can read the complete public core source code. No protection may depend on an undocumented endpoint, secret algorithm, hidden schema, or private implementation detail.

Production secrets, customer data, and environment-specific operational configuration must remain outside the public source tree.

## 5. Stage 1 — Runtime abstraction

### 5.1 Goal

Make Codex the first runtime implementation rather than a core Agenticform domain assumption.

This stage is primarily a refactor with compatibility requirements. Existing Codex agents, task DAGs, capability profiles, messaging, incidents, recovery state, node placement, approvals, and operations must continue to work throughout migration.

### 5.2 Domain model

Introduce stable runtime-neutral concepts:

```text
Agent
- id
- projectId
- name
- responsibility
- runtimeType
- runtimeProfileId
- runtimeSessionId        // opaque to core domain
- runtimeGeneration
- workspace...
- status...
```

The core domain must not require a field named `codexThreadId`.

A runtime session identifier is opaque outside the adapter that created it.

### 5.3 Runtime SPI

Define an internal contract conceptually equivalent to:

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

The exact Java API may differ, but core orchestration must depend on this boundary rather than directly on Codex protocol types.

### 5.4 Codex adapter

Existing Codex behavior becomes `CodexAgentRuntime` or equivalent.

It remains responsible for:

- Codex App Server transport;
- thread/turn creation and mapping;
- Codex event translation;
- dynamic Agenticform tools;
- approval proxying;
- Codex queue semantics;
- reconnect/reconciliation;
- runtime inventory reporting.

### 5.5 Runtime-neutral node capability advertisement

Execution nodes advertise runtime inventory as structured capabilities, for example:

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

The existing capability-profile system from PR #14 should be reused/extended rather than replaced. Agent requirements and node runtime capabilities must compose into one deterministic placement decision.

The control plane schedules against runtime requirements, capability profile requirements, protocol compatibility, trust, capacity, and placement constraints rather than a hard-coded `hasCodex` flag.

### 5.6 Credential profile model

Introduce a runtime credential/profile reference without requiring cloud custody of credentials.

For customer-owned nodes a credential profile may mean only:

```text
profile id: codex-personal
runtime: CODEX
placement scope: node-123
credential storage: NODE_LOCAL
status: HEALTHY
```

The actual credential remains in the runtime's local credential store.

### 5.7 Migration

Existing Codex agents migrate to:

```text
runtimeType = CODEX
runtimeSessionId = previous codexThreadId
```

No destructive reset of existing agent, task dependency, capability, message, incident, or recovery state is acceptable.

### 5.8 Not required in this stage

A second production runtime is not required for completion. The abstraction must be proven by contract tests and by ensuring Codex uses only the abstraction. A lightweight fake/test runtime may be used to prove that orchestration is no longer Codex-specific.

### 5.9 Exit criteria

Stage 1 is complete when:

- no core project/task/message/policy/operation/incident code needs Codex protocol classes;
- existing Codex behavior passes regression tests;
- capability-aware task dispatch still works through the runtime-neutral scheduler;
- execution-node scheduling uses runtime capabilities plus existing capability profiles;
- runtime session IDs are opaque to the core domain;
- recovery and generation fencing operate through the runtime abstraction;
- execution-node protocol compatibility semantics remain enforced;
- adding a second runtime no longer requires schema redesign of `Agent` or `Task`.

## 6. Stage 2 — Identity and tenancy

### 6.1 Goal

Evolve the single-owner bootstrap model into explicit users, organizations, memberships, roles, sessions, and organization-scoped resources without breaking self-hosted single-user use.

### 6.2 Core hierarchy

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

### 6.3 Resource ownership

Every customer-owned resource must either:

1. carry an explicit `organization_id`; or
2. be provably organization-scoped through a required parent relationship with database constraints and authorization checks.

Tenant ownership must not be inferred from untrusted request data.

### 6.4 Roles

Minimum v1 organization roles:

- `OWNER`
- `ADMIN`
- `DEVELOPER`
- `VIEWER`

Authorization must be capability-based internally even if the first UI exposes only these four named roles.

| Capability | Owner | Admin | Developer | Viewer |
|---|---:|---:|---:|---:|
| manage organization | yes | limited | no | no |
| manage members | yes | yes | no | no |
| register projects | yes | yes | yes | no |
| spawn/manage agents | yes | yes | yes | no |
| approve protected operations | yes | configurable | configurable | no |
| manage nodes/credentials | yes | yes | limited | no |
| view incidents/signals | yes | yes | yes | yes |
| view state/audit | yes | yes | yes | yes |

The policy engine remains responsible for semantic action governance. RBAC answers **who may request/decide**; policy answers **whether the requested action is allowed, human-gated, or denied**.

### 6.5 Authentication

Self-hosted must support an easy bootstrap path while sharing the same identity model as Cloud.

Required architecture:

- secure first-owner bootstrap;
- browser user sessions or short-lived access tokens with explicit expiration/revocation semantics;
- an authentication-provider boundary suitable for local credentials and/or OIDC;
- API tokens/service identities represented separately from human sessions;
- CSRF/session protections appropriate to the selected browser authentication model;
- login, logout, session revocation, and account recovery flows.

The current admin token may remain as a narrowly scoped emergency/bootstrap mechanism for self-hosted compatibility, but it must not be the normal multi-user Cloud authorization model.

### 6.6 Tenant-safe machine identity

Execution nodes are enrolled into exactly one organization for v1.

Node authentication must resolve the organization from server-side enrolled-node state. A node must never choose an arbitrary organization identifier in a request.

All agent runtime commands, events, approvals, messages, capability inventories, incidents/signals, Git credentials, and recovery placement must preserve organization ownership.

### 6.7 Tenant-safe communication and live events

PR #14 introduces explicit cross-project communication rules and SSE live events. Tenancy must tighten these boundaries:

- cross-project communication is possible only within explicitly authorized organization scope;
- cross-organization agent communication is denied in v1;
- SSE/event subscriptions are organization-scoped server-side;
- conversation/reply views must never resolve recipients or messages across tenant boundaries;
- fanout/background delivery must carry tenant context rather than infer it from recipient IDs alone.

### 6.8 Tenant-safe provider integrations

GitHub installations and future providers become organization-scoped integrations.

A credential broker request must be authorized across:

```text
organization
  + node
  + project
  + runtime generation
  + registered repository
```

A token or provider installation belonging to Organization A must never be usable by Organization B.

### 6.9 Data migration

Existing single-owner installations migrate into a generated default organization. Existing projects, agents, tasks/dependencies, conversations/messages, nodes, capability profiles, policy rules, signals/incidents, operations, and audit history are attached to that organization without requiring recreation.

### 6.10 Isolation tests

The test suite must include systematic negative tests proving Organization A cannot:

- read/update/delete Organization B projects;
- discover or control Organization B agents;
- inspect or mutate Organization B task dependencies;
- send/read conversations or messages from Organization B;
- dispatch or inspect Organization B tasks;
- approve Organization B actions;
- read/update Organization B signals/incidents;
- inspect or control Organization B execution nodes;
- obtain Organization B GitHub/runtime credentials;
- subscribe to Organization B SSE/events;
- access Organization B operation evidence or audit rows;
- cause background schedulers/reconcilers to operate on Organization B resources through substituted identifiers.

### 6.11 Exit criteria

Stage 2 is complete when:

- all customer resources have a defined organization ownership path;
- authenticated human users and organization memberships replace shared admin-token authorization for normal UI/API access;
- RBAC is enforced server-side;
- node, communication, live-event, incident, and provider integrations are tenant-scoped;
- existing installations migrate into a default organization;
- cross-tenant negative tests cover REST, SSE/event streams, node endpoints, broker endpoints, message fanout, incidents, and background schedulers.

## 7. Stage 3 — Product packaging

### 7.1 Goal

Build on the production container packaging delivered by PR #14 and turn it into a supported self-hosted product.

This stage does **not** start by creating the first production containers. Its job is to turn those containers into immutable release artifacts with a coherent install, bootstrap, configuration, upgrade, backup/restore, compatibility, and support contract.

### 7.2 Supported self-hosted deployment

The baseline supported deployment is Docker Compose:

```text
reverse proxy / TLS
        │
        ▼
agenticform-web/server
        │
        ▼
postgres
```

The exact image split may use one or multiple application containers, but the release artifact must be versioned and immutable.

### 7.3 Release artifacts

Each release must provide:

- versioned control-plane container image(s), based on the PR #14 production packaging;
- versioned execution-node image;
- immutable image digests;
- `docker-compose.yml` or equivalent supported stack;
- `.env.example` containing no secrets;
- database migration compatibility notes;
- release notes and upgrade instructions;
- rollback constraints;
- backup/restore procedure.

### 7.4 First-run experience

A clean install must support:

```text
configure public URL
      ↓
start stack
      ↓
open browser
      ↓
bootstrap first owner
      ↓
create/select organization
      ↓
register project or enroll node
      ↓
run first agent
```

No manual database editing is acceptable.

### 7.5 Configuration model

Configuration must be separated into:

- non-secret product configuration;
- secret references/values;
- deployment-specific infrastructure configuration.

Startup must validate incompatible or unsafe configurations and fail with actionable errors.

### 7.6 Upgrade and migration contract

Supported upgrades must:

- run Flyway migrations automatically or through a documented pre-start migration job;
- preserve the migration ordering established by PR #14 and rebased Sprint 13;
- never silently discard tenant, agent, dependency, conversation, incident, or operational state;
- document breaking configuration changes;
- support backup before migration;
- define downgrade/rollback limitations where database migrations are irreversible.

The first deployment to `https://agentic.investdx.biz.id` must use this path rather than custom manual startup commands.

### 7.7 Backup and restore

Minimum supported recovery unit:

- PostgreSQL state;
- necessary self-hosted configuration/secrets backed up separately by the operator;
- node identities remain node-local and are re-enrollable if lost.

Documentation must distinguish durable control-plane state from disposable/reconstructable worktrees.

### 7.8 Operational health

Product packaging must expose:

- liveness;
- readiness;
- database migration/readiness state;
- version/build metadata;
- node compatibility visibility;
- durable signal/incident visibility for relevant product health conditions.

### 7.9 License

The project may use a permissive open-source license such as MIT or Apache-2.0. Licensing is not a security boundary. Cloud differentiation must come from service quality, operations, product experience, integrations, support, and optional private commercial services rather than relying on source secrecy.

A license file must exist before the v1 public release.

### 7.10 Exit criteria

Stage 3 is complete when:

- a clean machine can install Agenticform from published release artifacts without building from source;
- `docker compose up -d` or one documented equivalent brings up a supported self-hosted stack;
- first-owner bootstrap is browser-driven;
- upgrades, backup, restore, and rollback boundaries are documented and tested;
- the reserved public domain can be deployed using only supported packaging;
- version compatibility between control plane and execution node is enforced or clearly negotiated;
- the production containers introduced before this stage are now part of a repeatable supported release process.

## 8. Stage 4 — Cloud service

### 8.1 Goal

Operate the same Agenticform product as a hosted multi-tenant control plane while keeping customer execution on enrolled customer nodes by default.

### 8.2 Cloud topology

```text
                    Internet
                       │
                       ▼
               Agenticform Cloud
         ┌────────────────────────────┐
         │ identity / organizations   │
         │ orchestration / policy     │
         │ incidents / operations     │
         │ API / UI / event streams   │
         │ audit / usage metadata     │
         └─────────────┬──────────────┘
                       │ HTTPS outbound from customer
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  customer node A customer node B customer node C
       runtime          runtime          runtime
       source           source           source
       credentials      credentials      credentials
```

The existing outbound-only node design is the default Cloud execution model.

### 8.3 Public endpoint

`https://agentic.investdx.biz.id` is the initial reserved public endpoint for the hosted Agenticform service unless superseded intentionally before launch.

Production routing must terminate TLS, enforce HTTPS, and preserve the application's signed-node-request semantics without relying on source IP trust.

### 8.4 Organization onboarding

Cloud onboarding minimum flow:

```text
sign in
  ↓
create organization
  ↓
create/register project
  ↓
enroll execution node
  ↓
node advertises runtimes/capabilities
  ↓
spawn agent
```

Inviting additional organization members should be supported before general availability.

### 8.5 Cloud execution boundary

For v1, Cloud must support BYO execution nodes as a first-class path. Managed Agenticform-hosted execution is optional and not required for Cloud launch.

The cloud control plane must not require inbound SSH or an inbound agent port on customer machines.

### 8.6 Runtime credentials

Runtime credentials stored on customer nodes remain node-local. Cloud stores only credential-profile metadata, placement constraints, and health state unless a user explicitly configures a separate cloud-custodied provider integration.

### 8.7 Git provider onboarding

Cloud should prefer GitHub App organization/repository authorization over global PAT storage.

Installation mappings must be tenant-scoped and visible/manageable by authorized organization members.

### 8.8 Plans and entitlements

The initial Cloud implementation must have an entitlement model even if billing is not enabled on day one.

Example enforceable dimensions:

- organization member count;
- registered projects;
- execution nodes;
- concurrent active agents;
- task DAG/concurrency limits;
- audit retention;
- message/event/incident history retention;
- advanced integrations/features.

Entitlements must be enforced server-side and must not be UI-only feature flags.

### 8.9 Email and transactional communication

Cloud requires a provider boundary for transactional messages such as:

- organization invitations;
- authentication/recovery messages where applicable;
- security alerts;
- important node/account notifications.

Provider-specific implementation is operational configuration, not core domain behavior.

### 8.10 Cloud admin boundary

Internal platform operators need separate administrative tooling/roles from customer organization owners.

A platform operator must not silently impersonate a tenant user. Any exceptional support access to tenant data must be explicit, least-privilege, time-bounded where possible, and auditable.

### 8.11 Incident integration

Cloud-service health and customer-visible failures should reuse the durable signal/incident model where the semantics fit:

- service degradation can emit operational signals;
- deterministic correlation can aggregate related failures;
- customer-visible incident state must remain tenant-safe;
- platform-wide incidents and tenant incidents must be distinguishable;
- internal platform evidence must not leak into unrelated tenant views.

### 8.12 Exit criteria

Stage 4 is complete when:

- multiple independent organizations can use one hosted control plane safely;
- each organization can enroll its own nodes and run agents with node-local runtime credentials;
- organization invitations and roles work;
- GitHub integration is tenant-scoped;
- entitlements are represented and enforced;
- operational signals/incidents behave correctly in a multi-tenant environment;
- the reserved public endpoint can serve the hosted UI/API with production TLS and supported deployment automation;
- self-hosted and Cloud execute the same core agent/task/message/policy/incident/operation semantics.

## 9. Stage 5 — Production SaaS hardening

### 9.1 Goal

Move from functional hosted beta to a service that can safely support untrusted tenants, failures, noisy workloads, operational incidents, and upgrades.

### 9.2 Tenant isolation hardening

Perform an explicit tenant-boundary review across:

- REST endpoints;
- SSE/event streams;
- background schedulers;
- task dependency resolution;
- capability-profile lookup;
- message routing/fanout and completion acknowledgement;
- approval dispatch;
- node command queues;
- runtime events;
- credential broker;
- webhook correlation;
- signal/incident correlation and incident tooling;
- operational runbooks;
- audit/event queries;
- caches;
- metrics/log labels;
- exports/support tooling.

Tests must use at least two organizations and attempt adversarial cross-tenant identifier substitution.

### 9.3 Rate limits and quotas

Introduce limits at appropriate scopes:

```text
IP / unauthenticated boundary
user
organization
execution node
runtime/session
provider integration
```

Limits should protect expensive actions such as agent spawn, task dispatch, dependency fanout, event/message fanout, credential issuance, enrollment creation, incident creation/correlation, and API polling without breaking long-running durable work.

### 9.4 Resource scheduling protection

The control plane must protect itself from one noisy organization through bounded:

- worker pools;
- queue consumption;
- task-DAG expansion;
- message/event fanout;
- incident/signal retention;
- concurrent operations;
- reconciliation loops;
- database query sizes;
- response payloads.

Fairness does not require a complex distributed queue in v1, but one tenant must not be able to starve all others trivially.

### 9.5 Usage metering

Persist enough usage facts to explain and enforce service limits, including at least:

- active/concurrent agents;
- execution-node count/status;
- task/runtime activity;
- message/event activity where relevant to limits;
- operation execution;
- selected storage/history dimensions.

Agenticform should not pretend it can perfectly meter third-party model spend when credentials and billing belong to customer runtime providers. Provider-reported usage may be surfaced where available, but Agenticform billing should initially be based on dimensions it can measure reliably.

### 9.6 Auditability

Audit logs must capture security-relevant actions with:

- organization;
- actor type and actor id;
- action;
- target;
- result;
- timestamp;
- relevant policy/RBAC decision;
- request/correlation identifiers where appropriate.

Secrets and sensitive credential payloads must never be written to audit logs.

### 9.7 Observability

Production requires structured, tenant-safe observability:

- application metrics;
- queue/scheduler metrics;
- task dependency/backlog metrics;
- message delivery/completion metrics;
- node online/offline and command latency metrics;
- runtime start/failure/recovery metrics;
- approval latency;
- signal/incident metrics;
- operation state metrics;
- database pool/latency/error metrics;
- logs with correlation IDs;
- distributed request tracing where useful.

Tenant identifiers in telemetry must be controlled to avoid high-cardinality explosions and accidental disclosure.

### 9.8 SLOs and alerting

Define initial service objectives for at least:

- control-plane API availability;
- task/node command dispatch latency;
- message/event delivery/reconciliation health;
- incident/signal processing health;
- database health;
- queue backlog;
- public endpoint certificate/routing health.

Alerts should represent user-impacting symptoms rather than every internal warning. Durable Agenticform incidents may be created from selected service-health signals, but external alerting must still exist for cases where the control plane itself is unavailable.

### 9.9 Security controls

Before GA:

- secret scanning in CI/repository;
- dependency and container vulnerability scanning;
- image provenance/digest pinning for production;
- secure headers and TLS enforcement;
- session/token rotation and revocation paths;
- webhook signature enforcement;
- node key revocation and re-enrollment procedures;
- execution-node protocol compatibility enforcement;
- least-privilege database/runtime identities;
- backup encryption/access controls;
- documented vulnerability reporting/security policy.

### 9.10 Data lifecycle

Define retention/deletion behavior for:

- user accounts;
- organizations;
- projects;
- task/dependency history;
- conversation/message/event history;
- signals/incidents;
- audit logs;
- operation evidence;
- node records;
- integration metadata.

Organization deletion must be explicit and asynchronous if necessary, but it must have a deterministic completion model and must not leave active nodes authorized indefinitely.

### 9.11 Disaster recovery

Cloud must document and test:

- database backups;
- point-in-time recovery if supported;
- restore verification;
- loss of an application instance;
- safe restart/reconciliation;
- credential/key rotation after compromise;
- execution node reconnection after control-plane recovery;
- recovery of durable task/message/incident state without unsafe replay.

The existing fail-closed recovery semantics should be preserved rather than bypassed for convenience.

### 9.12 Deployment safety

Production deploys must support:

- immutable versioned images;
- migration validation before rollout;
- health/readiness gating;
- controlled rollout/restart strategy;
- rollback decision path;
- compatibility policy for older execution-node versions.

### 9.13 Abuse and support controls

Provide platform-level controls to:

- suspend a user/organization;
- revoke organization sessions/tokens;
- disable/revoke execution nodes;
- stop new agent/task scheduling for an organization;
- inspect service/incident health without exposing unrelated tenants;
- retain an auditable reason for high-impact platform actions.

### 9.14 Exit criteria

Stage 5 is complete when:

- cross-tenant isolation has dedicated automated negative tests and manual review;
- quotas/rate limits prevent trivial noisy-neighbor exhaustion;
- production observability and alerting cover critical service paths;
- durable incident handling has been validated under tenant isolation and platform-failure scenarios;
- backups and restore have been exercised;
- security scanning and release provenance are part of CI/CD;
- tenant suspension/revocation and data-deletion flows exist;
- Cloud upgrades are repeatable and rollback boundaries are understood;
- a documented production-readiness review finds no known critical blocker.

## 10. Proposed sprint mapping

Sprint 13 is already the Operational Intelligence work represented by PR #13. PR #14 is a prerequisite tech-debt closure PR and is **not** redefined as Sprint 14 by this document.

The intended order is:

| Sprint / prerequisite | Product stage | Primary outcome |
|---|---|---|
| PR #14 prerequisite | Tech Debt Closure | close Sprints 1–12 architecture/security debt; production containers; DAG/capabilities/SSE/message lifecycle/etc. |
| 13 | Operational Intelligence | durable signals/incidents, deterministic correlation, service-health evidence, Operational Agent incident response |
| 14 | Runtime abstraction | Codex becomes the first runtime adapter; core domain becomes runtime-neutral |
| 15 | Identity & tenancy foundation | users, organizations, memberships, tenant ownership, migration |
| 16 | Tenant authorization & integration isolation | RBAC, tenant-safe nodes/GitHub/messages/events/incidents/background jobs, adversarial tests |
| 17 | Product packaging | turn existing production containers into supported self-hosted releases, bootstrap, upgrades, backup/restore |
| 18 | Cloud service foundation | hosted multi-tenant deployment, onboarding, BYO nodes, public endpoint |
| 19 | Cloud product controls | invitations, entitlements, usage foundation, platform admin boundary |
| 20 | SaaS hardening I | quotas, rate limits, noisy-neighbor controls, isolation review |
| 21 | SaaS hardening II / v1 readiness | observability, DR, security/release hardening, GA readiness |

Sprint boundaries may move if implementation evidence warrants it, but stages must not be reordered casually. In particular, Cloud must not precede tenant isolation, and additional runtime providers must not block runtime abstraction completion.

## 11. v1 definition of done

Agenticform v1 is considered product-complete when both supported modes pass the same functional control-plane contract.

### Self-Hosted

A user can:

1. install from published immutable artifacts;
2. bootstrap the first owner;
3. create/use an organization;
4. register/discover a repository/project;
5. enroll one or more execution nodes;
6. detect authenticated supported runtimes and enforce capability requirements;
7. create agents with responsibility/workspace/runtime/capability configuration;
8. dispatch durable tasks with dependencies;
9. use agent-to-agent communication and conversations;
10. use HITL/HOTL and deterministic policy;
11. observe durable operational signals/incidents;
12. hand off operational work and observe durable operations;
13. restart control plane/node and recover according to documented semantics;
14. upgrade and restore using supported procedures.

### Agenticform Cloud

A user can:

1. access the hosted public endpoint;
2. authenticate and create/join an organization;
3. invite members with roles;
4. connect organization-scoped GitHub resources;
5. enroll customer-owned execution nodes without inbound ports;
6. keep runtime credentials node-local by default;
7. execute the same agent/task/message/policy/incident/operation lifecycle as self-hosted;
8. view usage/limits and audit-relevant history;
9. operate without accessing another organization's resources;
10. survive normal control-plane rollout/restart without unsafe replay.

## 12. Explicitly deferred beyond v1

The following are valuable but must not delay this roadmap unless they become prerequisites through implementation evidence:

- Agenticform-hosted managed execution fleet;
- runtime/provider marketplace;
- large catalog of runtime adapters;
- Kubernetes operator;
- cross-region active-active control plane;
- complex consumption-based third-party LLM rebilling;
- enterprise SCIM/SAML feature completeness;
- arbitrary workflow-language product;
- public plugin marketplace;
- mobile applications.

## 13. Architecture decision summary

The roadmap commits to these decisions unless superseded by a documented ADR:

1. PR #14 merges before Sprint 13, Sprint 13 is rebased on it, and this roadmap begins from their combined final state.
2. Agenticform remains one core product for Cloud and Self-Hosted.
3. Codex becomes an adapter behind a runtime abstraction.
4. Existing capability profiles, task DAGs, message lifecycle semantics, SSE, incident intelligence, and recovery semantics are retained rather than replaced.
5. Organizations become the primary customer isolation boundary.
6. Customer execution nodes remain the default Cloud execution model.
7. Runtime credentials remain node-local by default.
8. Human identity, node identity, runtime credentials, and provider credentials stay distinct.
9. Product packaging builds on PR #14 production containers and precedes Cloud launch.
10. Security assumes the core source code is public.
11. Permissive licensing such as MIT or Apache-2.0 is acceptable and is not treated as a security boundary.
12. `https://agentic.investdx.biz.id` is reserved for the future public Agenticform service and must be deployed using the supported product path, not one-off development commands.
