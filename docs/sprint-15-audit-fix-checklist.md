# Sprint 15 — Audit Fix Checklist

Audit baseline: September 13, 2026. Scope covers all persisted agents, tasks, messages, deliveries, runtime interactions, node commands, approvals, and recent server/node logs.

## Workflow correctness

- [x] Add server-owned task kinds: orchestration, architecture, implementation, review, test, operations.
- [x] Derive task kind from agent capability when omitted.
- [x] Reject implementation tasks without `WRITE` capability.
- [x] Reject review tasks without `REVIEW` capability.
- [x] Require implementation evidence before Orchestrator completion.
- [x] Require architecture evidence before Orchestrator completion.
- [x] Require completed review evidence before Orchestrator completion.
- [x] Preserve parent task context and parent linkage for delegated work.
- [x] Add active-scope deduplication for equivalent delegated tasks.
- [x] Add task kinds as explicit workflow phases and canonical workflow IDs.
- [ ] Reconcile provably stale historical tasks without rewriting uncertain history.

## Generic agent roster

- [x] Remove Backend-specific workflow wording.
- [x] Add generic Implementer template.
- [x] Add Frontend, Data, and DevOps Implementer templates.
- [x] Tell Orchestrator to select by capability/specialty.
- [x] Persist structured specialties separately from free-form responsibility.

## Runtime and queue reliability

- [x] Preserve runtime generation and task dependency gates.
- [x] Preserve stale-turn cleanup before redispatch.
- [x] Fence every remote dynamic-tool call by `(agent, runtime generation)` with a structured stale result.
- [ ] Stop old Codex threads after terminal task state.
- [ ] Deduplicate retry tasks after runtime failure.
- [ ] Revoke/clean the historical node identity after operator confirmation.

## UI and observability

- [x] Hide child tasks from the default task list.
- [x] Expose durable messages and approvals in the UI.
- [x] Show task kind and specialty in the UI.
- [ ] Show dependency reason, blocker, runtime generation, and next action.
- [ ] Add task graph detail view.
- [ ] Fix SSE authorization/reconnect errors after response commit.

## Verification

- [x] Go node tests pass.
- [x] Maven tests pass with host-network Maven container.
- [x] Web type-check and production build pass with Node 22.
- [ ] Build release images.
- [ ] Deploy and smoke-test the Sprint 15 stack.
- [ ] Push the verified commit to `feat/seamless-self-hosted-alpha`.
