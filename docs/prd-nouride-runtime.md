# PRD — Nouride Lightweight Agent Runtime

Status: Proposed  
Owner: Agenticform  
Target: Runtime abstraction / execution-node platform  
Primary reference: https://nouride.com/en/docs/cli/reference/

## 1. Summary

Agenticform currently ships Codex as its first `AgentRuntime` implementation. Sprint 14 intentionally made orchestration runtime-neutral so a second runtime can be added without changing the task, messaging, approval, recovery, or scheduling core.

This PRD proposes **Nouride as the first non-Codex runtime adapter**, with the working hypothesis that Nouride can host a higher density of lightweight logical agents than a Codex-first topology and is therefore a better default candidate for roles that do not require a full coding-agent runtime.

The resource-efficiency claim is a **hypothesis to be benchmarked, not an accepted fact**. The implementation must not promote Nouride to a default runtime until measured results demonstrate a meaningful density and operational advantage on representative Agenticform nodes.

The intended product split is:

- **Agenticform** remains the durable control plane and source of truth.
- **Nouride** is evaluated as a lightweight, headless agent execution runtime.
- **Codex** remains available as a specialized coding runtime.
- Runtime selection is explicit per agent and schedulable per execution node.

## 2. Problem

Not every Agenticform role needs the same runtime weight or coding capabilities.

Examples include:

- project orchestrators;
- reviewers;
- planners;
- researchers;
- operational reasoning agents;
- product agents;
- triage agents;
- agents waiting primarily on durable messages or external events.

Using a coding-oriented runtime for every logical agent can waste memory and process capacity, reduce the number of agents that fit on a node, and couple the product too tightly to one execution engine.

Agenticform already owns the responsibilities that should remain durable and runtime-independent:

- projects and agent identity;
- responsibilities and roles;
- durable tasks and queues;
- agent-to-agent communication;
- deterministic policy;
- human-in-the-loop and human-on-the-loop supervision;
- node placement;
- runtime generation fencing;
- recovery;
- workspaces;
- operational runbooks and external waits.

The missing proof point is a second runtime implementation that exercises the abstraction in production-shaped conditions.

## 3. Product hypothesis

If Nouride can multiplex or otherwise host many logical agents with materially lower idle and active resource overhead than the equivalent Codex topology, then Agenticform can increase agent density while preserving Codex for workloads that benefit from its coding-specific capabilities.

The target architecture is therefore heterogeneous rather than replacement-only:

```text
                         Agenticform
                       control plane
                            |
              durable orchestration / policy
                            |
                    agenticform-node
                            |
              +-------------+-------------+
              |                           |
              v                           v
       Nouride runtime              Codex runtime
       lightweight roles            coding-heavy roles
              |                           |
       model providers                Codex stack
```

A project may mix runtimes:

```text
Project
├── Orchestrator          runtime=NOURIDE
├── Product Agent         runtime=NOURIDE
├── Backend Engineer      runtime=CODEX
├── Frontend Engineer     runtime=CODEX
├── Reviewer              runtime=NOURIDE
└── Operational Agent     runtime=NOURIDE
```

This is an example policy, not a hard-coded role-to-runtime mapping.

## 4. Goals

1. Add Nouride as a real second `AgentRuntime` without changing core orchestration semantics.
2. Validate whether Nouride provides a meaningful resource-density advantage over Codex on representative execution nodes.
3. Allow runtime selection per agent.
4. Allow a single execution node to advertise and host both `CODEX` and `NOURIDE` runtimes.
5. Preserve Agenticform as the single durable control plane.
6. Preserve exact runtime-generation fencing and stale-runtime rejection.
7. Preserve deterministic `ALLOW`, `REQUIRE_HUMAN`, and `DENY` policy semantics.
8. Preserve HITL and HOTL behavior independently of runtime.
9. Keep Codex fully supported and avoid a forced migration.
10. Establish a reusable pattern for future runtime adapters.

## 5. Non-goals

This PRD does not propose:

- replacing Agenticform scheduling with Nouride scheduling;
- replacing Agenticform approvals with Nouride approvals;
- replacing Agenticform agent-to-agent communication with a second communication fabric;
- making Nouride's dashboard a second control plane;
- removing Codex;
- parsing an interactive TUI as a production integration protocol;
- accepting resource-efficiency claims without benchmark evidence;
- weakening execution-node security, workspace isolation, or policy gates to fit a runtime;
- exposing Nouride directly to the public network.

## 6. Design principles

### 6.1 One control plane

Agenticform owns durable intent. Runtime-local state is execution state, not product truth.

The following stay in Agenticform/PostgreSQL:

- agent definitions;
- task state;
- durable queue state;
- messages and delivery state;
- approvals;
- policy decisions;
- node assignment;
- runtime generation;
- recovery state;
- operation and incident state.

### 6.2 Headless integration only

The adapter must use a documented machine-consumable Nouride interface suitable for automation.

Acceptable surfaces include a stable daemon API, RPC protocol, structured stdio protocol, or deterministic headless CLI with machine-readable events.

Interactive terminal scraping is not an acceptable production transport.

### 6.3 Runtime is a binding, not the agent identity

The domain model remains:

```text
Agent
├── identity
├── responsibility
├── instructions
├── skills/capabilities
├── workspace policy
├── supervision mode
└── runtime binding
    ├── CODEX
    └── NOURIDE
```

An Agenticform agent must not become synonymous with a Nouride session.

### 6.4 Fail closed

If Nouride cannot prove session identity, current generation, workspace binding, or policy compatibility, Agenticform must reject or stop the runtime rather than guess.

## 7. Proposed runtime topology

The preferred topology, subject to validation of Nouride's supported process model, is one supervised Nouride service per execution node with multiple logical agent sessions beneath it:

```text
execution node
│
├── agenticform-node
│
├── Nouride service
│   ├── agent/session A
│   ├── agent/session B
│   ├── agent/session C
│   └── ...
│
└── Codex runtime(s)
```

If Nouride does not provide safe multi-session isolation inside one service, the adapter may use multiple Nouride processes. The PRD's density hypothesis must then be benchmarked against that actual topology rather than assuming daemon multiplexing.

Agenticform must not depend on an undocumented assumption that one Nouride daemon can safely multiplex arbitrary independent agents.

## 8. Runtime contract

`NourideAgentRuntime` must satisfy the existing runtime abstraction rather than adding Nouride-specific branches to task orchestration.

Required lifecycle operations:

- `start`
- `dispatch`
- `resume`
- `interrupt`
- runtime-specific start parameters through the existing adapter boundary

Required runtime properties:

- opaque stable `runtimeSessionId`;
- explicit runtime type `NOURIDE`;
- deterministic mapping between Agenticform agent/generation and Nouride execution identity;
- observable start/ready/running/terminal states;
- cancellable active turn;
- recoverable session or a well-defined rehydration path;
- structured terminal result and error classification.

The core orchestration layer must not import Nouride-specific transport classes.

## 9. Execution-node contract

Execution nodes advertise runtime inventory explicitly, for example:

```json
{
  "runtimes": [
    {
      "type": "CODEX",
      "status": "READY"
    },
    {
      "type": "NOURIDE",
      "status": "READY"
    }
  ]
}
```

Placement continues to use runtime requirements such as:

```text
runtime:codex
runtime:nouride
```

The node must reject a `NOURIDE` command when Nouride is unavailable or unhealthy.

Nouride must remain node-local. Agenticform communicates with the authenticated `agenticform-node`; it does not expose or directly address a Nouride service over the public network.

## 10. Session identity and fencing

All remote runtime commands and events continue to be fenced by:

```text
(node, generation, runtimeType, runtimeSessionId)
```

For Nouride this becomes:

```text
(node-X, generation-7, NOURIDE, opaque-session-id)
```

Requirements:

- a stale Nouride session cannot mutate a newer generation;
- events from an unknown session are rejected;
- a node restart must report runtime inventory sufficient for reconciliation;
- an ambiguous prior side effect is not replayed automatically;
- recovery creates a new runtime generation when the old execution identity can no longer be trusted.

## 11. Workspaces and isolation

Coding-capable Nouride agents must use Agenticform-managed workspace policy.

Requirements:

- no arbitrary host path access outside allowed roots;
- coding agents use isolated Git worktrees by default;
- runtime start receives the resolved workspace rather than choosing one independently;
- cleanup remains owned by Agenticform/node lifecycle logic;
- runtime-local session state must not silently outlive the Agenticform workspace generation;
- credentials remain brokered and scoped; they are not embedded in repository URLs or durable runtime config.

A lightweight non-coding agent may be created without a repository worktree when its role does not require filesystem access.

## 12. Tools and policy governance

Nouride must not become a bypass around Agenticform policy.

Protected semantic effects continue through Agenticform policy and runbooks:

```text
agent reasoning
    |
    v
request semantic action
    |
    v
Agenticform policy
ALLOW / REQUIRE_HUMAN / DENY
    |
    v
approved deterministic effect
```

The adapter must define which Nouride tools are:

- safe runtime-local operations;
- Agenticform-mediated tools;
- prohibited or disabled tools.

High-blast-radius effects such as deploy, migration, production mutation, credential access, and destructive operations must not be unlocked by selecting Nouride's most permissive mode.

If Nouride has its own approval model, it is defense-in-depth only. Agenticform remains authoritative for governed operations.

## 13. HITL and HOTL

Supervision mode is an Agenticform concept and must work identically across runtimes.

### Human in the loop

The task pauses at a governed decision point and resumes only after durable human approval.

### Human on the loop

The agent may continue within its granted policy envelope while Agenticform exposes activity, interventions, interrupts, and escalation points to the operator.

Changing `CODEX` to `NOURIDE` must not change the semantic meaning of either mode.

## 14. Runtime selection UX

Agent creation/editing should eventually expose runtime selection:

```text
Runtime
○ Automatic
○ Nouride
○ Codex
```

`Automatic` is not enabled until there is a deterministic placement policy with measurable inputs.

Initial implementation may require explicit `NOURIDE` or `CODEX` selection.

The UI should show:

- selected runtime;
- node placement;
- runtime health;
- session/generation status;
- current model/provider when available;
- runtime-specific diagnostics behind an advanced view.

Runtime implementation details should not dominate the normal task UX.

## 15. Provider and model configuration

Nouride provider/model selection must be expressed through runtime-specific configuration while preserving Agenticform's neutral agent domain.

Conceptual example:

```yaml
agent:
  name: reviewer
  runtime: NOURIDE
  supervision: HUMAN_ON_THE_LOOP

runtimeConfig:
  provider: <configured-provider>
  model: <configured-model>
```

Exact Nouride field names and CLI/API parameters must come from validated Nouride documentation or an integration spike. They must not be guessed into the production contract.

Secrets must use Agenticform's existing credential/security patterns and must not be stored in ordinary agent configuration payloads.

## 16. Resource-density benchmark

The main product claim must be proven with a reproducible benchmark.

### 16.1 Test environments

At minimum test:

- one small self-hosted VM representative of Agenticform's intended deployment;
- one larger development/server node;
- Linux, which is the primary execution-node environment.

Record:

- CPU model/count;
- total RAM;
- OS/kernel;
- runtime versions;
- model/provider;
- Agenticform commit;
- benchmark workload commit/configuration.

### 16.2 Scenarios

Measure both Codex and Nouride using equivalent logical workloads where technically meaningful:

1. runtime installed but no agents;
2. 1 idle agent;
3. 5 idle agents;
4. 10 idle agents;
5. 25 idle agents where capacity permits;
6. 1 active agent;
7. 5 concurrently active agents;
8. burst dispatch;
9. long-lived mostly-idle agents receiving periodic messages;
10. restart/recovery after node or runtime restart.

### 16.3 Metrics

Capture at least:

- resident memory of runtime processes;
- total node memory attributable to runtime sessions;
- idle CPU;
- active CPU;
- process/thread count;
- time to create an agent session;
- time to first token/event where observable;
- dispatch-to-completion latency for the fixed workload;
- maximum stable concurrent logical agents;
- crash/restart behavior;
- leaked processes/sessions after cleanup;
- workspace/disk overhead;
- provider token usage only when the compared workload is equivalent enough for the number to be meaningful.

### 16.4 Promotion gate

Nouride may be described in product UI/docs as the "lightweight" runtime only after benchmark evidence supports that statement on representative hardware.

Until then use neutral language such as:

> Nouride runtime (experimental)

The benchmark result should be committed as a reproducible report rather than retained only in a local test session.

## 17. Functional acceptance criteria

The Nouride runtime is functionally complete when all of the following are true:

- [ ] `NourideAgentRuntime` implements the existing `AgentRuntime` SPI.
- [ ] Core task/message/operation orchestration has no Nouride-specific dependency.
- [ ] Local Nouride agent start works.
- [ ] Remote Nouride agent start through `agenticform-node` works.
- [ ] Task dispatch works with structured completion/error reporting.
- [ ] Active work can be interrupted.
- [ ] A session can be resumed or deterministically rehydrated.
- [ ] Node restart reconciliation works.
- [ ] Stale-generation events are rejected.
- [ ] Runtime inventory reports `NOURIDE` health.
- [ ] Scheduler can place `runtime:nouride` agents only on capable nodes.
- [ ] Workspace isolation matches Agenticform policy.
- [ ] Protected operations cannot bypass Agenticform policy.
- [ ] HITL approval survives control-plane/node/runtime restart.
- [ ] HOTL interrupt/escalation works.
- [ ] Agent-to-agent communication works across mixed Codex/Nouride projects.
- [ ] Nouride and Codex can coexist on one node.
- [ ] Nouride failure does not break Codex agents on the same node.
- [ ] The second-runtime Sprint 14 exit gate can be marked complete without changing orchestration core semantics.

## 18. Performance acceptance criteria

No fixed RAM number is defined before measurement.

The performance evaluation must answer:

1. Does Nouride use materially less idle memory per logical agent in the topology Agenticform can actually support?
2. Does it materially increase stable logical-agent density on a fixed node?
3. Does the gain survive realistic active workloads rather than only idle sessions?
4. Is the resource gain worth any loss in capability, isolation, observability, or recovery quality?
5. Is one shared service safer and more efficient than multiple Nouride processes?

A default-runtime decision requires documented evidence for these questions.

## 19. Reliability acceptance criteria

- no orphan runtime may continue mutating state after its generation is replaced;
- duplicate commands preserve the node's effectively-once side-effect semantics;
- ambiguous prior side effects fail closed;
- runtime crashes produce durable, classifiable failure state;
- restart does not silently create duplicate logical agents;
- runtime-local state is reconcilable against Agenticform durable state;
- a permanently lost node follows existing rehydration rules rather than inventing a Nouride-only recovery path.

## 20. Security acceptance criteria

Before production enablement:

- review Nouride's license and redistribution constraints;
- pin an approved version/build and verify integrity in the node image/install path;
- document runtime update policy;
- identify every network listener Nouride starts, if any;
- bind runtime services to node-local interfaces/stdio unless a stronger authenticated local transport is required;
- verify secrets are not written into logs, ordinary session state, or Git configuration;
- enumerate enabled tools and filesystem permissions;
- test path traversal and workspace-boundary behavior;
- test approval/policy bypass attempts;
- include Nouride in node compromise-containment documentation.

## 21. Observability

Agenticform should expose neutral runtime metrics first:

- runtime type;
- runtime health;
- active session count;
- idle session count where knowable;
- start failures;
- dispatch failures;
- interrupts;
- recoveries;
- stale-event rejections;
- runtime resource usage where available.

Runtime-specific logs remain diagnostic detail and should be correlated with:

```text
projectId
agentId
nodeId
generation
runtimeType
runtimeSessionId
taskId
```

## 22. Rollout plan

### Phase 0 — Documentation and protocol spike

- validate the current Nouride CLI/daemon/API documentation;
- determine the supported machine-readable integration surface;
- determine whether safe multi-session multiplexing is supported;
- determine session persistence/resume semantics;
- determine cancellation semantics;
- document license and distribution constraints.

Exit gate: no unresolved protocol assumption blocks an adapter.

### Phase 1 — Local experimental adapter

- add `NOURIDE` runtime type;
- implement `NourideAgentRuntime` locally;
- start/dispatch/interrupt/resume;
- add focused contract tests;
- no default-runtime behavior.

Exit gate: existing orchestration core remains unchanged except neutral extension points.

### Phase 2 — Execution-node support

- add Nouride runtime inventory;
- node-local supervisor/integration;
- remote start/dispatch/stop/reconcile;
- generation fencing;
- mixed runtime node tests.

Exit gate: remote recovery and stale-runtime tests pass.

### Phase 3 — Policy and supervision

- tool capability mapping;
- Agenticform-mediated protected operations;
- HITL/HOTL compatibility tests;
- mixed-runtime communication tests.

Exit gate: no known policy bypass from runtime selection.

### Phase 4 — Benchmark

- run the reproducible density suite;
- publish benchmark artifact/report;
- compare actual supported Nouride topology with Codex;
- record operational trade-offs.

Exit gate: evidence supports or rejects the lightweight-runtime hypothesis.

### Phase 5 — Optional product promotion

Only if previous gates pass:

- expose Nouride runtime selection broadly;
- optionally introduce an `Automatic` runtime policy;
- document recommended role/runtime patterns;
- consider Nouride for default lightweight/general roles.

## 23. Automatic runtime selection — future work

A future scheduler may select runtime from explicit capabilities rather than role names.

Example inputs:

- requires coding tools;
- requires repository mutation;
- requires specific model/provider;
- requires runtime-specific feature;
- expected task duration;
- node memory pressure;
- runtime health;
- supervision mode;
- workspace requirements.

Example conceptual policy:

```text
if task requires CODEX-only capability
    -> CODEX
else if NOURIDE satisfies required capabilities and node policy
    -> NOURIDE
else
    -> any compatible healthy runtime
```

This must remain deterministic and explainable. Agenticform must show why a runtime was selected.

## 24. Open questions

These must be answered from current Nouride documentation and/or a controlled spike before implementation is considered stable:

1. What is Nouride's supported non-interactive integration protocol?
2. Can one service safely host multiple independent sessions?
3. What isolation exists between those sessions?
4. Are session IDs stable across service restart?
5. What state must be persisted to resume?
6. Can an active turn be interrupted deterministically?
7. Are tool calls/events streamable in a structured format?
8. Can Agenticform inject or mediate protected tools without TUI automation?
9. Does Nouride open network listeners, and can they remain loopback-only?
10. What are the license/redistribution obligations for the Agenticform node image?
11. What is the actual memory/CPU curve at 1/5/10/25 agents?
12. Does shared-daemon failure create an unacceptable correlated-failure domain?

## 25. Definition of done

This initiative is done when:

- Nouride is a production-shaped second runtime implementation behind the existing runtime abstraction;
- Codex and Nouride coexist without runtime-specific branching in core orchestration;
- recovery, fencing, policy, HITL/HOTL, workspace isolation, and durable communication pass the same semantic expectations for both runtimes;
- a reproducible benchmark establishes whether Nouride is actually lighter in the topology Agenticform supports;
- the product only calls Nouride "lightweight" if the evidence supports the claim;
- the Sprint 14 second-runtime exit gate is closed with implementation and test evidence.

## 26. Decision record

The intended architectural direction is:

```text
Agenticform = durable agent control plane
Nouride     = candidate lightweight/general runtime
Codex       = specialized coding runtime
Go node     = secure execution host and runtime supervisor
PostgreSQL  = durable source of truth
```

This PRD deliberately avoids making Nouride the new control plane. Agenticform should gain runtime diversity without duplicating scheduling, approvals, communication, recovery, or policy authority.
