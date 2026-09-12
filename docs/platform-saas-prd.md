# Agenticform Platform & SaaS PRD

Status: Proposed  
Baseline: `main` after Sprint 12 — Distributed Recovery & Runtime Reliability  
Reserved public endpoint: `https://agentic.investdx.biz.id`  
Target outcome: production-grade Agenticform Self-Hosted plus Agenticform Cloud with customer-owned execution nodes by default.

## 1. Executive summary

Agenticform already has the hard execution-plane foundation required for a serious agent control plane:

- durable projects, agents, tasks, communication, approvals, policy, and operations;
- isolated coding workspaces;
- one system-managed Operational Agent per project;
- deterministic `ALLOW / REQUIRE_HUMAN / DENY` policy enforcement;
- HITL and HOTL operating modes;
- outbound-only distributed execution nodes;
- Ed25519 node identity, replay protection, trust/capability/capacity-aware placement;
- runtime-generation fencing;
- durable node effects and restart-safe remote approvals;
- node-loss rehydration for eligible Git-backed agents;
- GitHub App based short-lived repository credentials;
- durable GitHub Actions waits and operational recovery.

The next product phase is not another rewrite of agent execution. The objective is to turn this distributed Codex-oriented control plane into a provider-neutral product that can operate in two first-class deployment models:

1. **Agenticform Self-Hosted** — customer operates the complete control plane and execution fleet.
2. **Agenticform Cloud** — Agenticform operates the control plane while execution remains on customer-enrolled nodes by default.

The required work is organized into five consecutive product stages:

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

These stages are intentionally ordered. Runtime abstraction prevents SaaS/domain state from becoming permanently Codex-specific. Identity and tenancy establish the security boundary before hosting multiple organizations. Packaging proves that the same product can be operated cleanly by customers. Cloud service then hosts that product without changing execution semantics. SaaS hardening closes reliability, abuse, observability, isolation, and operational gaps before v1 general availability.

`https://agentic.investdx.biz.id` is reserved as the future public Agenticform endpoint. It is not treated as an existing production deployment or migration source. The first deployment to that domain must use the same supported packaging, configuration, migrations, and operational procedures documented by this roadmap.

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

## 3. Current baseline

This PRD assumes the Sprint 12 architecture as the migration baseline, not a green-field system.

### 3.1 Capabilities already present

The current control plane already provides:

- project registry;
- agent lifecycle and durable tasks;
- direct, multicast, role, group, and project-broadcast communication;
- isolated Git worktrees and fail-closed cleanup;
- HITL / HOTL modes;
- persisted deterministic policy rules;
- project-scoped Operational Agents and immutable operational runbooks;
- GitHub Actions dispatch/wait/reconciliation;
- execution-node enrollment and signed device authentication;
- capability/trust/capacity-aware node placement;
- remote Codex execution over node-local stdio;
- runtime generation fencing;
- durable remote approvals and node command effects;
- restart and node-loss recovery;
- GitHub App credential brokering for private repositories;
- React control-center UI.

These are retained. The following stages generalize and productize them.

### 3.2 Known product gaps

The main gaps are now above the execution engine:

- core domain state still exposes Codex-specific concepts;
- operator identity is a single admin bearer token rather than users and organizations;
- resources are not tenant-scoped;
- the repository is developer-deployable but not yet a polished self-hosted product;
- there is no hosted multi-tenant control-plane product boundary;
- there are no SaaS-grade quota, abuse, isolation, metering, support, and operational controls.

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

Deployment-specific adapters and commercial modules may differ, but task, agent, runtime, node, policy, and operational semantics must remain shared.

### 4.2 Runtime credentials stay at the execution boundary by default

Agenticform Cloud must not require customer Codex/Claude/Gemini credentials to be stored in the cloud control plane when a runtime executes on a customer node.

The node reports runtime capability and authentication health, not the credential itself.

### 4.3 Tenant identity is an authorization boundary

Once tenancy exists, an organization identifier is not decorative metadata. Every tenant-owned resource and every access path must be organization-scoped server-side.

A caller must never gain access to another organization by knowing or guessing a project, task, agent, approval, node, message, operation, runbook, or event identifier.

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

### 4.5 Fail closed on ambiguous side effects

The Sprint 12 principle remains: if Agenticform cannot prove that replay, cleanup, ownership, authorization, or continuation is safe, it must stop and require reconciliation rather than guess.

### 4.6 Public-source compatible security

Security must assume an attacker can read the complete public core source code. No protection may depend on an undocumented endpoint, secret algorithm, hidden schema, or private implementation detail.

Production secrets, customer data, and environment-specific operational configuration must remain outside the public source tree.

## 5. Stage 1 — Runtime abstraction

### 5.1 Goal

Make Codex the first runtime implementation rather than a core Agenticform domain assumption.

This stage is primarily a refactor with compatibility requirements. Existing Codex agents, tasks, recovery state, node placement, approvals, and operations must continue to work throughout migration.

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

Existing Codex behavior becomes `CodexAgentRuntime`/equivalent.

It remains responsible for:

- Codex App Server transport;
- thread/turn creation and mapping;
- Codex event translation;
- dynamic Agenticform tools;
- approval proxying;
- Codex queue semantics;
- reconnect/reconciliation;
- runtime inventory reporting.

### 5.5 Node capability advertisement

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

The control plane schedules against runtime requirements, not a hard-coded `hasCodex` flag.

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

Existing Codex agents are migrated to:

```text
runtimeType = CODEX
runtimeSessionId = previous codexThreadId
```

No destructive reset of existing agent state is acceptable.

### 5.8 Not required in this stage

A second production runtime is not required for completion. The abstraction must be proven by contract tests and by ensuring Codex uses only the abstraction. A lightweight fake/test runtime may be used to prove that orchestration is no longer Codex-specific.

### 5.9 Exit criteria

Stage 1 is complete when:

- no core project/task/message/policy/operation code needs Codex protocol classes;
- existing Codex behavior passes regression tests;
- execution-node scheduling uses runtime capabilities;
- runtime session IDs are opaque to the core domain;
- recovery and generation fencing operate through the runtime abstraction;
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
               ├── Tasks
               ├── Execution Nodes
               ├── Policies
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

All agent runtime commands, events, approvals, Git credentials, inventories, and recovery placement must preserve organization ownership.

### 6.7 Tenant-safe provider integrations

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

### 6.8 Data migration

Existing single-owner installations migrate into a generated default organization. Existing projects, agents, nodes, policy rules, operations, and audit history are attached to that organization without requiring recreation.

### 6.9 Isolation tests

The test suite must include systematic negative tests proving Organization A cannot:

- read/update/delete Organization B projects;
- discover or control Organization B agents;
- send messages to Organization B agents;
- dispatch or inspect Organization B tasks;
- approve Organization B actions;
- inspect or control Organization B execution nodes;
- obtain Organization B GitHub/runtime credentials;
- subscribe to Organization B events;
- access Organization B operation evidence or audit rows.

### 6.10 Exit criteria

Stage 2 is complete when:

- all customer resources have a defined organization ownership path;
- authenticated human users and organization memberships replace shared admin-token authorization for normal UI/API access;
- RBAC is enforced server-side;
- node and provider integrations are tenant-scoped;
- existing installations migrate into a default organization;
- cross-tenant negative tests cover REST, event streams, node endpoints, broker endpoints, and background schedulers.

## 7. Stage 3 — Product packaging

### 7.1 Goal

Turn the repository from developer-deployable software into a supported self-hosted product.

A new user should not need to understand the internal Maven/Vite/Go development topology to install Agenticform.

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

- versioned control-plane container image(s);
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
- never silently discard tenant or agent state;
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
- node compatibility visibility.

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
- version compatibility between control plane and execution node is enforced or clearly negotiated.

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
node advertises runtimes
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
- audit retention;
- event/history retention;
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

### 8.11 Exit criteria

Stage 4 is complete when:

- multiple independent organizations can use one hosted control plane safely;
- each organization can enroll its own nodes and run agents with node-local runtime credentials;
- organization invitations and roles work;
- GitHub integration is tenant-scoped;
- entitlements are represented and enforced;
- the reserved public endpoint can serve the hosted UI/API with production TLS and supported deployment automation;
- self-hosted and Cloud execute the same core agent/task/policy semantics.

## 9. Stage 5 — Production SaaS hardening

### 9.1 Goal

Move from functional hosted beta to a service that can safely support untrusted tenants, failures, noisy workloads, operational incidents, and upgrades.

### 9.2 Tenant isolation hardening

Perform an explicit tenant-boundary review across:

- REST endpoints;
- WebSocket/SSE/event streams;
- background schedulers;
- approval dispatch;
- node command queues;
- runtime events;
- credential broker;
- webhook correlation;
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

Limits should protect expensive actions such as agent spawn, task dispatch, event fanout, credential issuance, enrollment creation, and API polling without breaking long-running durable work.

### 9.4 Resource scheduling protection

The control plane must protect itself from one noisy organization through bounded:

- worker pools;
- queue consumption;
- fanout;
- event retention;
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
- node online/offline and command latency metrics;
- runtime start/failure/recovery metrics;
- approval latency;
- operation state metrics;
- database pool/latency/error metrics;
- logs with correlation IDs;
- distributed request tracing where useful.

Tenant identifiers in telemetry must be controlled to avoid high-cardinality explosions and accidental disclosure.

### 9.8 SLOs and alerting

Define initial service objectives for at least:

- control-plane API availability;
- task/node command dispatch latency;
- event delivery/reconciliation health;
- database health;
- queue backlog;
- public endpoint certificate/routing health.

Alerts should represent user-impacting symptoms rather than every internal warning.

### 9.9 Security controls

Before GA:

- secret scanning in CI/repository;
- dependency and container vulnerability scanning;
- image provenance/digest pinning for production;
- secure headers and TLS enforcement;
- session/token rotation and revocation paths;
- webhook signature enforcement;
- node key revocation and re-enrollment procedures;
- least-privilege database/runtime identities;
- backup encryption/access controls;
- documented vulnerability reporting/security policy.

### 9.10 Data lifecycle

Define retention/deletion behavior for:

- user accounts;
- organizations;
- projects;
- task/message/event history;
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
- execution node reconnection after control-plane recovery.

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
- stop new agent scheduling for an organization;
- inspect service health without exposing unrelated tenants;
- retain an auditable reason for high-impact platform actions.

### 9.14 Exit criteria

Stage 5 is complete when:

- cross-tenant isolation has dedicated automated negative tests and manual review;
- quotas/rate limits prevent trivial noisy-neighbor exhaustion;
- production observability and alerting cover critical service paths;
- backups and restore have been exercised;
- security scanning and release provenance are part of CI/CD;
- tenant suspension/revocation and data-deletion flows exist;
- Cloud upgrades are repeatable and rollback boundaries are understood;
- a documented production-readiness review finds no known critical blocker.

## 10. Proposed sprint mapping

This PRD does not require every stage to fit into exactly one sprint. The numbering below extends the existing sprint history and defines the intended sequence.

| Sprint | Product stage | Primary outcome |
|---|---|---|
| 13 | Runtime abstraction | Codex becomes the first runtime adapter; core domain becomes runtime-neutral |
| 14 | Identity & tenancy foundation | users, organizations, memberships, tenant ownership, migration |
| 15 | Tenant authorization & integration isolation | RBAC, tenant-safe nodes/GitHub/events/background jobs, adversarial tests |
| 16 | Product packaging | supported self-hosted images/Compose, bootstrap, upgrade, backup/restore |
| 17 | Cloud service foundation | hosted multi-tenant deployment, onboarding, BYO nodes, public endpoint |
| 18 | Cloud product controls | invitations, entitlements, usage foundation, platform admin boundary |
| 19 | SaaS hardening I | quotas, rate limits, noisy-neighbor controls, isolation review |
| 20 | SaaS hardening II / v1 readiness | observability, DR, security/release hardening, GA readiness |

Sprint boundaries may move if implementation evidence warrants it, but stages must not be reordered casually. In particular, Cloud must not precede tenant isolation, and additional runtime providers must not block runtime abstraction completion.

## 11. v1 definition of done

Agenticform v1 is considered product-complete when both supported modes pass the same functional control-plane contract.

### Self-Hosted

A user can:

1. install from published immutable artifacts;
2. bootstrap the first owner;
3. create/use an organization;
4. register a repository/project;
5. enroll one or more execution nodes;
6. detect authenticated supported runtimes;
7. create agents with responsibility/workspace/runtime configuration;
8. dispatch durable tasks;
9. use agent-to-agent communication;
10. use HITL/HOTL and deterministic policy;
11. hand off operational work and observe durable operations;
12. restart control plane/node and recover according to documented semantics;
13. upgrade and restore using supported procedures.

### Agenticform Cloud

A user can:

1. access the hosted public endpoint;
2. authenticate and create/join an organization;
3. invite members with roles;
4. connect organization-scoped GitHub resources;
5. enroll customer-owned execution nodes without inbound ports;
6. keep runtime credentials node-local by default;
7. execute the same agent/task/policy/operation lifecycle as self-hosted;
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

1. Agenticform remains one core product for Cloud and Self-Hosted.
2. Codex becomes an adapter behind a runtime abstraction.
3. Organizations become the primary customer isolation boundary.
4. Customer execution nodes remain the default Cloud execution model.
5. Runtime credentials remain node-local by default.
6. Human identity, node identity, runtime credentials, and provider credentials stay distinct.
7. Product packaging precedes Cloud launch.
8. Security assumes the core source code is public.
9. Permissive licensing such as MIT or Apache-2.0 is acceptable and is not treated as a security boundary.
10. `https://agentic.investdx.biz.id` is reserved for the future public Agenticform service and must be deployed using the supported product path, not one-off development commands.
