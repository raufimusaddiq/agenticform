# Agenticform Platform & SaaS PRD

Status: Proposed  
Baseline: `main` after PR #14 — Tech Debt Closure and Sprint 13 / PR #13 — Operational Intelligence  
Baseline commit: `76e5afa5803917c9db766b6ba54bdf50fce35b58`  
Reserved public endpoint: `https://agentic.investdx.biz.id`  
Target outcome: release a seamless, genuinely usable Agenticform Self-Hosted product as early as possible, then evolve the same core into Agenticform Cloud with clear paid value beyond simply hosting the same software.

## 1. Executive summary

Agenticform is the durable control plane above coding-agent runtimes such as Codex, Claude Code, Gemini CLI, and future runtimes. It owns agent identity, responsibility, task orchestration, communication, policy, approvals, incidents, operations, runtime placement, and recovery while keeping runtime implementation details behind adapters.

The merged baseline is:

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
Platform / product phase
```

PR #14 and Sprint 13 already provide substantial orchestration, distributed-node, policy, recovery, operational-intelligence, and container foundations. The next phase must turn those capabilities into software that is actually pleasant to install and use before spending several sprints on SaaS infrastructure.

The revised delivery order is:

```text
Sprint 14 — Runtime Abstraction
        │
        ▼
Sprint 15 — Seamless Self-Hosted Alpha
        │      usable every day
        │      simple installation
        │      real dogfooding
        ▼
Sprint 16 — Identity / Organization / RBAC
        │
        ▼
Sprint 17 — Tenant & Integration Isolation
        │
        ▼
Sprint 18 — Self-Hosted Beta / v1 Hardening
        │
        ▼
Sprint 19 — Agenticform Cloud Foundation
        │
        ▼
Sprint 20 — Managed Execution MVP
        │
        ▼
Sprint 21 — Cloud Product Controls
        │
        ▼
Sprint 22 — SaaS Hardening / Paid Readiness
```

The key product decision is that **Self-Hosted Alpha must already be usable and seamless**. `Alpha` describes compatibility/support guarantees, not poor UX. Normal installation and daily operation must not require manual SQL, direct API calls, editing internal database rows, hand-wiring Docker networks, or understanding Agenticform internals.

The second product decision is that Cloud needs value beyond “we run the same Docker Compose for you.” Cloud provides a managed control plane, managed data lifecycle and integrations, collaboration/usage capabilities, and eventually **managed execution** so a customer can connect repositories and run an agent organization without operating execution infrastructure.

`https://agentic.investdx.biz.id` remains reserved as a future Agenticform endpoint. It is not currently an existing production deployment.

---

## 2. Product thesis

Agenticform does not compete with coding runtimes on model intelligence. It coordinates them as a software-engineering organization.

```text
                         Agenticform

                 organizations / projects
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
             execution infrastructure
```

Product promise:

> Turn machines and repositories into a governed, durable, observable software-engineering agent organization.

Longer-term Cloud promise:

> Connect your repositories and run an autonomous engineering organization without having to operate the Agenticform control plane or, when desired, the execution infrastructure.

---

## 3. Product editions and commercial boundary

### 3.1 Agenticform Self-Hosted

Self-Hosted is a first-class product, not a deliberately crippled edition.

It includes the core engineering-agent platform:

- projects and agents;
- runtime abstraction and runtime adapters;
- customer-owned execution nodes;
- task orchestration and dependency DAGs;
- agent communication and conversations;
- HITL / HOTL;
- policy and approvals;
- Operational Agent, incidents, and operations;
- runtime recovery and node-loss handling;
- basic organization/RBAC once introduced;
- local audit/history according to the deployment's own storage.

The operator owns:

- control-plane availability;
- PostgreSQL;
- upgrades;
- backups;
- TLS/domain/reverse proxy;
- runtime and provider credentials;
- execution fleet.

The self-hosted installation must nevertheless be seamless.

### 3.2 Agenticform Cloud

Cloud uses the same core domain semantics but removes operational burden and adds managed product capabilities.

Cloud owns:

- control-plane hosting and availability;
- managed PostgreSQL/data lifecycle;
- upgrades and migrations;
- backup and disaster-recovery procedures;
- public endpoint/TLS;
- managed integrations;
- organization onboarding and invitations;
- usage measurement and entitlements;
- product analytics/alerts;
- platform operations and support controls.

Cloud supports two execution modes:

```text
BYO execution
Agenticform Cloud
      ↓ outbound HTTPS
customer-owned node
      ↓
Codex / Claude / runtime
```

and later:

```text
Managed execution
Connect repository
      ↓
Agenticform Cloud
      ↓
managed ephemeral worker
      ↓
runtime
      ↓
result / PR / operation
```

BYO execution remains important for privacy, private networks, custom tooling, and customer-owned runtime credentials. Managed execution is the primary future convenience differentiator.

### 3.3 Enterprise

Enterprise differentiation should focus on governance, compliance, support, and deployment controls rather than withholding basic orchestration from Self-Hosted.

Candidate Enterprise capabilities:

- SSO / SAML / OIDC enterprise configuration;
- SCIM;
- dedicated control plane;
- private networking;
- custom data retention;
- enterprise audit/export controls;
- advanced policy/governance;
- managed execution fleet options;
- support SLA;
- compliance and support-access controls.

---

## 4. Merged baseline carried forward

The roadmap extends the existing system rather than implementing parallel replacements:

- project registry and approved-root discovery;
- durable agent lifecycle and deterministic stop lifecycle;
- durable tasks with dependency DAG and dependency-aware dispatch;
- persisted capability profiles and enforcement;
- direct, multicast, role, group, project-broadcast, and governed cross-project communication;
- durable message delivery with processing/completion acknowledgement;
- conversation/reply UI;
- isolated Git worktrees and fail-closed cleanup;
- HITL and HOTL operating modes;
- deterministic `ALLOW / REQUIRE_HUMAN / DENY` policy rules;
- payload-bound one-shot policy preauthorization;
- system-managed Operational Agent;
- immutable policy-gated operational runbooks;
- durable GitHub Actions dispatch/wait/reconciliation;
- outbound-only execution-node enrollment;
- Ed25519 node identity and replay protection;
- trust/capacity scheduling and protocol compatibility fencing;
- runtime-generation fencing;
- effectively-once node effects and fail-closed ambiguous effects;
- restart-safe remote approvals;
- node-loss rehydration for eligible Git-backed agents;
- GitHub App short-lived repository credential brokering;
- SSE control-plane events;
- durable operational signals/incidents/evidence;
- node-aware Operational Agent wake-up;
- production control-plane/web container builds.

---

## 5. Product principles

### 5.1 Seamless before broad

A smaller feature set that installs cleanly and works end-to-end is more valuable than a larger architecture that has not been operated in real usage.

Every self-hosted milestone must optimize for:

```text
install
→ open UI
→ onboard node/project
→ run agent
→ observe/approve/intervene
→ recover/restart
```

### 5.2 Alpha is a support level, not a UX excuse

Self-Hosted Alpha may allow breaking changes between releases and may not promise long-term upgrade compatibility. It must not require awkward day-to-day operation.

### 5.3 One core product

Self-Hosted and Cloud share Agent, Runtime, Task, Message, Policy, Approval, Incident, Operation, and Node semantics. Cloud-specific managed services compose around the same core instead of creating a second orchestration engine.

### 5.4 Organization is the tenant boundary once tenancy exists

After Sprint 16/17, customer resources must have an explicit or provable organization owner. Knowing a UUID must never grant access to another organization's resource.

### 5.5 Runtime/provider credentials stay at the execution boundary by default

Customer-owned nodes keep runtime credentials locally unless a later managed-execution product explicitly requires a different credential model.

### 5.6 Runtime implementations stay behind adapters

Core project/task/message/policy/incident/operation code must not depend on Codex protocol classes or Codex-specific persistence concepts.

### 5.7 Preserve safety semantics

All productization work must preserve:

- runtime-generation fencing;
- protocol compatibility fencing;
- durable message semantics;
- approval durability;
- policy enforcement;
- ambiguous-effect fail-closed behavior;
- deterministic cleanup;
- node identity and request authenticity.

---

## 6. Sprint 14 — Runtime Abstraction

### Goal

Make Codex the first runtime adapter rather than a core-domain assumption.

### Required domain shape

```text
Agent
- id
- projectId
- name
- responsibility
- runtimeType
- runtimeProfileId
- runtimeSessionId       // opaque outside runtime adapter
- runtimeGeneration
- workspace...
- status...
```

Task/message execution identity must also be runtime-neutral. Core domain tables should not require fields such as `codexThreadId`, `codexTurnId`, or other provider-specific execution identifiers.

### Runtime SPI

Conceptual shape:

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

The exact interface may differ. The architectural requirement does not: runtime-specific start parameters, protocol payloads, events, approvals, and identifiers must be translated at the adapter boundary.

### Node capability inventory

Execution nodes advertise runtimes structurally:

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

Runtime requirements compose with trust, capacity, capability profile, protocol compatibility, and placement constraints.

### Pre-release compatibility policy

Agenticform has not yet shipped a supported deployment. Sprint 14 therefore should prefer a clean runtime-neutral schema/protocol over legacy compatibility that has no deployed consumer.

Do not keep permanent `threadId` compatibility fields or aliases solely for unreleased internal history. Historical Flyway files already merged to `main` should remain immutable where necessary for development DB consistency, but runtime/API contracts should converge directly on the intended model before Self-Hosted Alpha.

### Exit criteria

- core orchestration no longer imports Codex protocol/config types;
- task/message execution persistence is runtime-neutral;
- runtime IDs are opaque outside adapters;
- local and remote start/dispatch/interrupt/stop use the runtime abstraction;
- remote runtime event/request envelopes carry exact runtime identity;
- recovery and fencing operate through runtime-neutral identity;
- existing Codex behavior passes regression tests;
- adding a second test/runtime implementation does not require redesigning Agent or Task schema.

A second production runtime is not required for Sprint 14.

---

## 7. Sprint 15 — Seamless Self-Hosted Alpha

### Goal

After Sprint 15, Agenticform must be something the project owner can install on a normal server and use as a daily engineering tool across real projects and execution nodes.

**Definition:** Self-Hosted Alpha = usable + seamless.

The target flow is:

```text
obtain release
    ↓
configure minimal environment
    ↓
start Agenticform
    ↓
open browser
    ↓
bootstrap single owner/admin
    ↓
register/connect project
    ↓
enroll execution node with one copy-paste command
    ↓
see runtime readiness
    ↓
spawn agent
    ↓
use Agenticform normally
```

### 7.1 Installation contract

Provide a supported self-hosted stack built from versioned release images:

- control plane;
- web UI;
- PostgreSQL;
- execution-node image;
- persistent volumes;
- health/readiness checks;
- automatic Flyway migration;
- `.env.example` with safe/defaultable values;
- startup validation with actionable errors;
- build/version metadata.

`docker compose up -d` should be sufficient after minimal documented configuration. The user must not need to build source.

### 7.2 Seamless first-run UX

Normal setup must not require:

- manual SQL;
- manual database-row edits;
- direct REST/curl calls;
- manually creating internal IDs;
- patching Docker networks;
- manually running Flyway;
- editing generated internal state files.

Full multi-user identity is not required yet. A single-owner/admin bootstrap is acceptable for Alpha, but setup should handle credentials/secrets ergonomically rather than requiring the user to understand the auth implementation.

### 7.3 Node onboarding

Node enrollment must be one clear UI-driven flow:

```text
Nodes → Add Node
      ↓
create one-time enrollment
      ↓
copy one setup command
      ↓
run on target machine
      ↓
node appears automatically
```

The UI must expose runtime readiness separately from node connectivity, for example:

```text
Node: build-01          Online
CODEX                   Installed ✓
Authentication          Ready ✓
Version                 0.x.x
Capacity                1 / 4 agents
```

Failures must be actionable: runtime missing, runtime unauthenticated, incompatible node version, insufficient trust/capability, repository credential unavailable, or project placement invalid.

Node enrollment itself should be Agenticform-generic. Runtime-specific setup belongs to runtime detection/profile UX rather than defining an Agenticform node as permanently Codex-only.

### 7.4 Daily-use completeness

The Alpha release must support the real loop from the UI:

- register/discover a project;
- inspect/select execution node;
- inspect runtime readiness;
- spawn an agent with responsibility/workspace/runtime;
- create and dispatch tasks;
- observe task/agent state live;
- agent-to-agent messaging;
- HITL / HOTL;
- approvals and user input;
- interrupt/stop an agent;
- recover/reconnect a runtime;
- Operational Agent flows;
- operational incidents and basic evidence;
- useful failure states instead of silent hangs.

### 7.5 Operational ergonomics

Alpha must survive normal operator actions:

- control-plane restart;
- web restart;
- PostgreSQL restart;
- execution-node reconnect;
- runtime reconnect/recovery;
- server reboot.

Provide at least:

```bash
docker compose pull
docker compose up -d
```

as the normal update mechanism for Alpha releases.

Provide a basic documented database backup/restore path. Long-term compatibility guarantees are deferred, but losing state during ordinary restart/update is not acceptable.

### 7.6 Reverse proxy and networking

Self-Hosted must work cleanly behind common infrastructure such as Caddy, Traefik, Nginx, and Cloudflare proxying where applicable.

Document:

- public URL;
- TLS termination assumptions;
- Web/SSE proxy requirements;
- outbound node connectivity;
- health endpoints;
- required exposed ports.

### 7.7 Dogfood deployment

After Sprint 15, deploy the same supported Self-Hosted Alpha path for real use instead of maintaining a special developer-only deployment procedure.

Use the system against multiple real repositories and nodes. Product issues found during dogfooding feed directly into Sprint 16–18 priorities.

### Exit criteria

- a clean server installs from release artifacts without building source;
- normal startup is a documented, low-step process;
- first useful agent can be created without SQL/curl/internal editing;
- node enrollment is one copy-paste command from the UI;
- runtime readiness and failure reasons are visible;
- task/message/approval/operation flows work end-to-end;
- restart/reconnect paths preserve durable state;
- basic update and backup/restore paths exist;
- the project owner is using this release for real work.

---

## 8. Sprint 16 — Identity, Organization, and RBAC

### Goal

Replace the Alpha single-owner model with explicit identity while preserving the seamless Self-Hosted experience.

### Domain hierarchy

```text
User
  └── OrganizationMembership
         └── Organization
               ├── Projects
               ├── Agents / Tasks
               ├── Conversations / Messages
               ├── Execution Nodes
               ├── Policies / Approvals
               ├── Signals / Incidents
               ├── Operations
               ├── Credential Profiles
               └── Audit Events
```

Minimum roles:

- `OWNER`
- `ADMIN`
- `DEVELOPER`
- `VIEWER`

RBAC answers **who may request/decide**. Policy continues to answer **whether the requested action is allowed, denied, or requires a human**.

### Self-Hosted migration UX

Existing Alpha installs migrate into a default organization with the existing operator as owner. This migration should not force recreation of projects/nodes/agents.

### Authentication

Introduce:

- browser-friendly login/session handling;
- secure first-owner bootstrap;
- logout and session revocation;
- API/service identities separated from humans;
- provider boundary suitable for future OIDC;
- appropriate CSRF/session protection.

### Exit criteria

- Self-Hosted remains at least as easy to start/use as Alpha;
- users, organizations, memberships, and roles exist;
- existing Alpha state maps into a default organization;
- server-side RBAC is enforced;
- normal UI/API use no longer depends on a global admin token.

---

## 9. Sprint 17 — Tenant and Integration Isolation

### Goal

Make the organization boundary safe enough to host multiple independent organizations later.

Execution nodes belong to one organization for v1. Organization ownership must be derived from server-side enrollment/state rather than trusted caller input.

GitHub and future integrations are organization-scoped. Credential brokering verifies the relevant organization, node, project, runtime generation, and registered repository.

### Adversarial tests

Prove Organization A cannot access Organization B through:

- REST APIs;
- SSE/events;
- node commands;
- runtime callbacks/events;
- tasks/messages/conversations;
- approvals/policies;
- incidents/signals;
- operations/runbooks;
- Git/provider credential broker;
- background reconciliation;
- audit queries;
- integrations/webhooks.

### Exit criteria

- every customer resource has an organization ownership path;
- node/provider boundaries are tenant-safe;
- negative cross-tenant tests cover synchronous and asynchronous paths;
- background jobs do not bypass tenant boundaries.

---

## 10. Sprint 18 — Self-Hosted Beta / v1 Hardening

### Goal

Turn the dogfooded Alpha into a release suitable for external self-hosted users.

Alpha prioritized seamless real usage. This sprint adds stronger lifecycle/support contracts without regressing that UX.

### Required productization

- immutable versioned images/releases;
- stable release manifest/versioning;
- tested upgrade procedure;
- migration compatibility rules;
- tested backup/restore;
- rollback boundaries;
- compatibility matrix for control plane and execution node;
- release notes;
- first-run and recovery documentation;
- stronger diagnostics/support bundle;
- configuration validation;
- documented retention/storage expectations.

### Principle

External productization must not turn the easy Alpha flow into an enterprise installation procedure.

### Exit criteria

- new installations remain seamless;
- supported upgrades are tested;
- backup/restore is tested;
- node/control-plane compatibility is explicit;
- external users can install without source build or internal knowledge;
- breaking changes are governed by an explicit pre-v1/v1 policy.

---

## 11. Sprint 19 — Agenticform Cloud Foundation

### Goal

Run the same core product as a hosted multi-tenant control plane with customer-owned nodes as the initial execution path.

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
                       │ outbound HTTPS
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  customer node A customer node B customer node C
```

Cloud onboarding:

```text
sign in
→ create organization
→ connect project/provider
→ enroll node
→ node advertises runtimes
→ spawn agent
```

The initial hosted endpoint may use `https://agentic.investdx.biz.id` unless superseded before launch.

### Cloud-managed responsibilities

- control-plane deployment and upgrades;
- database operations;
- backups/DR;
- TLS/public endpoint;
- platform observability;
- organization onboarding/invitations;
- managed provider integration setup;
- auditable support/admin boundary.

### Exit criteria

- multiple organizations safely use one hosted control plane;
- organizations can enroll their own outbound-only nodes;
- runtime credentials remain node-local in BYO mode;
- tenant-scoped GitHub integration works;
- hosted upgrades/backup/restore are operationally tested.

---

## 12. Sprint 20 — Managed Execution MVP

### Goal

Create a meaningful Cloud differentiator: customers may run agents without supplying their own Agenticform execution node.

Target experience:

```text
connect GitHub
    ↓
select repository
    ↓
select runtime / execution mode
    ↓
spawn agent
    ↓
Agenticform provisions isolated worker
    ↓
work completes
    ↓
worker is recycled
```

### Requirements

- ephemeral or strongly isolated worker lifecycle;
- repository checkout and short-lived Git credentials;
- execution identity tied to organization/project/agent/generation;
- bounded CPU/memory/disk/time;
- clean worker disposal;
- runtime credential strategy appropriate to the supported runtime;
- network/security policy;
- logs/evidence returned to control plane;
- usage metering primitives;
- fail-closed cleanup and stale-generation handling.

BYO nodes remain supported and should not become second-class.

### Exit criteria

- a Cloud user can execute a supported workload without enrolling a customer node;
- managed execution remains isolated between organizations;
- credentials and source data have defined lifecycle/retention;
- worker cleanup is deterministic;
- usage can be measured for entitlement/billing decisions.

---

## 13. Sprint 21 — Cloud Product Controls

### Goal

Turn Cloud infrastructure into a product customers can administer and potentially pay for.

Add server-side primitives for:

- organization invitations/team lifecycle;
- usage dashboards;
- concurrent-agent/node/managed-execution limits;
- history/audit retention tiers;
- managed integration controls;
- notification/alert preferences;
- cost/runtime visibility where measurable;
- entitlement enforcement;
- plan-aware features without changing core execution semantics.

Potential paid value should emphasize:

```text
managed control plane
+ managed execution
+ integrations
+ collaboration
+ observability
+ retention/governance
```

not artificial restrictions on basic orchestration.

---

## 14. Sprint 22 — SaaS Hardening / Paid Readiness

### Goal

Make the hosted service safe for untrusted tenants, noisy workloads, continuous upgrades, support operations, and paid usage.

### Required areas

#### Isolation review

Adversarially review REST, SSE, schedulers, nodes, runtime events, credentials, provider integrations, operations, audit, caches, telemetry, and support tooling.

#### Rate limits and noisy-neighbor control

Apply appropriate limits by:

```text
IP / anonymous
user
organization
execution node
runtime/session
managed worker
provider integration
```

Bound worker pools and expensive fanout/reconciliation paths while preserving durable long-running work.

#### Reliability and SLOs

Define measurable service health for:

- API/control plane;
- event delivery;
- node command delivery;
- managed worker provisioning;
- provider integration;
- task/runtime recovery.

#### Data lifecycle

Define retention/deletion/export behavior for organizations, runtime metadata, audit history, logs, managed-execution artifacts, and support data.

#### Platform support boundary

Platform operators remain separate from customer organization owners. Support access is explicit, least-privilege, time-bounded where appropriate, and auditable.

#### Release safety

Cloud deploys require staged migration/deploy procedures, health gates, rollback boundaries, backup readiness, and provenance for released images.

### Exit criteria

- isolation review complete;
- rate limits/quotas enforced;
- managed execution has production isolation and lifecycle controls;
- usage/entitlements measurable;
- SLO/observability coverage exists;
- retention/deletion/support controls are defined and tested;
- release and recovery procedures are exercised.

---

## 15. Roadmap summary

| Sprint | Milestone | Primary outcome |
|---|---|---|
| 13 | Operational Intelligence | merged baseline |
| 14 | Runtime Abstraction | Codex becomes an adapter, not a core assumption |
| 15 | **Seamless Self-Hosted Alpha** | **install and use Agenticform for real work** |
| 16 | Identity / Organization / RBAC | multi-user product model |
| 17 | Tenant & Integration Isolation | safe organization boundary |
| 18 | Self-Hosted Beta / v1 Hardening | externally supportable self-hosted release |
| 19 | Cloud Foundation | hosted multi-tenant control plane + BYO nodes |
| 20 | **Managed Execution MVP** | **Cloud runs workloads without customer node** |
| 21 | Cloud Product Controls | collaboration, usage, entitlements, observability |
| 22 | SaaS Hardening / Paid Readiness | production paid-service readiness |

---

## 16. Self-Hosted Alpha acceptance test

Sprint 15 is not complete merely because containers start. A representative operator should be able to execute this without internal project knowledge:

```text
1. Obtain the supported release configuration.
2. Configure the minimal documented environment.
3. Start Agenticform.
4. Open the browser UI.
5. Complete single-owner bootstrap.
6. Register/connect a Git project.
7. Create an execution-node enrollment from the UI.
8. Run the generated command on another machine/server.
9. See the node online and runtime readiness in the UI.
10. Spawn an agent with a responsibility and runtime.
11. Dispatch a task.
12. Observe the task and runtime state live.
13. Complete a human approval/input request.
14. Send/receive an agent message.
15. Stop/recover an agent.
16. Restart Agenticform and verify durable state remains coherent.
17. Perform the documented backup path.
```

Any requirement for manual SQL, internal DB changes, direct API invocation, or undocumented repair during the happy path is a Sprint 15 product bug.

---

## 17. v1 boundary

### Self-Hosted v1 should include

- seamless installation and first-run;
- runtime-neutral core with at least Codex production-ready;
- project/agent/task/message orchestration;
- customer-owned nodes;
- HITL/HOTL and policy/approvals;
- Operational Agent and operational intelligence;
- users/organizations/basic RBAC;
- tenant-safe nodes/integrations even in a single self-hosted deployment;
- supported upgrades, backup/restore, diagnostics, and compatibility rules.

### Cloud v1 should include

- managed control plane;
- organizations/invitations/RBAC;
- BYO customer nodes;
- managed Git/provider integration;
- usage/entitlement primitives;
- Cloud operations/backup/observability;
- managed execution for at least one supported workload/runtime path, if it meets isolation and credential requirements.

### Explicitly deferrable beyond initial paid readiness

- runtime marketplace;
- Kubernetes operator;
- complex third-party LLM rebilling;
- many managed runtime providers simultaneously;
- advanced enterprise compliance certifications;
- globally distributed active-active control plane;
- generalized managed GPU/model hosting.

---

## 18. Decision rules for future roadmap changes

1. **Do not delay real usage for architecture that can safely be added after dogfooding.**
2. **Do not sacrifice runtime/domain correctness merely to release one sprint earlier.**
3. **Self-Hosted remains a real product, not a demo funnel.**
4. **Cloud must remove meaningful operational burden or add meaningful managed capability.**
5. **Managed execution is a strategic Cloud differentiator, but BYO nodes remain first-class.**
6. **Alpha may break between releases; its normal UX may not be broken.**
7. **Every new abstraction should prove a current product need or prevent a concrete architectural dead end.**
