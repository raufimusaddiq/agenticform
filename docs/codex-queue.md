# Agenticform — Codex Queue Orchestration

## 1. Why this document exists

Agenticform needs to accept work while a Codex agent is already busy, preserve that work durably, and decide when it is safe to run the next unit. Codex now exposes a per-thread user-message queue that is useful for this, but it should not replace Agenticform's own task orchestration layer.

The recommended model is deliberately two-layered:

```text
Agenticform task queue / scheduler
        │
        │ dispatch eligible work
        ▼
Codex thread queue
        │
        │ execute one thread-local input at a time
        ▼
Codex turn
```

Agenticform owns intent, dependencies, policy, approvals, priorities, cross-agent routing, and recovery. Codex owns the final thread-local execution inbox.

## 2. Research snapshot

Research date: 2026-09-11.

The findings below were checked against the current `openai/codex` main branch and current upstream issues. These details are implementation-sensitive and should be capability-detected rather than assumed forever.

### 2.1 Current Codex queue API

Codex App Server exposes experimental thread queue methods for user submissions:

```text
thread/queue/add
thread/queue/list
thread/queue/update
thread/queue/delete
thread/queue/reorder
thread/queue/start
```

It also emits:

```text
thread/queue/changed
```

The queue methods currently require the App Server experimental API handshake. Agenticform must therefore treat this integration as an optional capability behind the Codex gateway, not as a stable domain contract.

Relevant upstream code:

- `codex-rs/app-server-protocol/src/protocol/common.rs`
- `codex-rs/app-server/src/request_processors/thread_queue_processor.rs`
- `codex-rs/app-server/tests/suite/v2/thread_queue.rs`

### 2.2 Queue durability

The current local queue is backed by Codex's state database / SQLite when the local persistent thread store is available. In-memory thread stores do not get the queue backend.

Codex currently limits pending user submissions to **100 per thread**.

This makes the queue useful as a durable execution inbox, but Agenticform must not use the Codex queue itself as the only record that a product-level task exists.

Relevant upstream code:

- `codex-rs/app-server/src/message_processor.rs`
- `codex-rs/state/src/lib.rs`
- `codex-rs/thread-store/src/queue_store.rs`

### 2.3 Auto-dispatch behavior

When a durable queued item belongs to a loaded thread, Codex attempts to dispatch queued user input when that thread becomes idle. Queue service code serializes dispatch per thread, starts the next item only when the thread is idle, and removes the item after a turn successfully starts.

This is exactly the behavior we want for the last mile of execution: Agenticform does not need to race `turn/start` calls itself whenever an active turn finishes.

However, this behavior is thread-local. It does not understand Agenticform task dependencies, project policies, approval gates, task priority across agents, or resource budgets.

### 2.4 Important unloaded-thread edge case

As of 2026-09-11 there is an open upstream Codex issue, `openai/codex#44491`, describing a queue item successfully added to a persisted but unloaded thread that remains pending until the thread is explicitly resumed.

The current queue implementation calls `wake_if_loaded`; if the thread is not loaded, dispatch does not automatically bring the thread into memory. The issue reports a working mitigation: resume the thread, then use queue start only if it is still idle.

For Agenticform this means:

```text
accepted by thread/queue/add != guaranteed unattended execution
```

Agenticform must own a wake/reconcile loop for queued work targeting unloaded agents.

Reference:

- https://github.com/openai/codex/issues/44491

### 2.5 Failure and pause semantics are still evolving

There are open upstream requests around queue behavior after usage-limit failures and around manual/frozen queued messages. These are useful signals that the product-level policy should live in Agenticform rather than being delegated blindly to Codex auto-drain.

References:

- https://github.com/openai/codex/issues/24443 — preserve queued follow-ups on usage/credit exhaustion
- https://github.com/openai/codex/issues/30828 — manual approval before the next queued task
- https://github.com/openai/codex/issues/35357 — frozen/manual-release queued messages

These GitHub issues are requests/bug reports, not guarantees of current Codex behavior.

## 3. Decision: two queue layers

### Layer A — Agenticform Task Queue

This is the product-level source of truth in PostgreSQL.

It represents work such as:

- implement a backend change
- review another agent's branch
- answer another agent's question
- run tests after a dependency finishes
- investigate a failure
- prepare a deploy

It can exist before a Codex thread is available and can remain blocked without sending anything to Codex.

### Layer B — Codex Thread Queue

This is the execution inbox for one Codex thread.

It should contain only work that Agenticform has already decided is eligible to execute.

Do not enqueue a task into Codex merely because it exists in Agenticform.

## 4. Why Codex queue benefits Agenticform

### 4.1 No dropped follow-up while an agent is busy

Without a thread queue, Agenticform would need to choose among:

- reject new input while a turn is active
- steer the active turn and risk changing its goal
- maintain its own fragile turn-completion race

With the queue, eligible follow-up work can be durably staged for the same thread.

Example:

```text
Backend Agent
  running: Implement refresh-token fallback

Agenticform receives:
  1. Run auth regression tests
  2. Check token refresh metrics
  3. Answer Frontend Agent API question
```

Agenticform can decide which of these are eligible and stage them without interrupting the active implementation turn.

### 4.2 Better agent-to-agent communication

The existing architecture says a message sent to a busy agent should wait rather than mutate that agent's active turn. Codex queue gives us a native last-mile mechanism for that waiting message.

Example:

```text
Frontend Agent
      │ QUESTION
      ▼
AgentMessageRouter
      │ persist + authorize
      ▼
Agenticform dispatch decision
      │
      ├─ target idle   → start/queue immediately
      └─ target busy   → thread/queue/add
```

This is cleaner than steering every inter-agent message into the active turn.

### 4.3 Native per-thread ordering

Codex already supports list, update, delete, and reorder for queued submissions. Agenticform can expose a controlled view of the execution inbox while keeping product task state separately.

The user can therefore say:

```text
run review before tests
```

and Agenticform can reorder eligible thread submissions without changing the product-level history of the tasks.

### 4.4 Crash/restart resilience at two levels

A durable Agenticform task survives the Java process restarting.

A dispatched Codex queue item can also survive independently in Codex's persistent local queue.

The two identifiers let Agenticform reconcile after restart instead of guessing whether an instruction was delivered.

### 4.5 Reduced race conditions

For a loaded thread, Codex's queue service already owns the `start if idle` behavior under a thread-level dispatch lock. Agenticform should use that instead of implementing a second competing per-thread runner.

### 4.6 Human review modes

Because Agenticform owns the upper queue, we can support modes that Codex itself does not reliably expose as stable product semantics:

```text
AUTO
  dispatch the next eligible task automatically

REVIEW_BETWEEN_TASKS
  finish current task, then wait for user approval before dispatching the next

PAUSED
  retain queued work but dispatch nothing
```

This is especially useful for writer agents operating on production repositories.

## 5. Domain model changes

### 5.1 Task

Extend `Task` conceptually with:

```text
Task
- id
- projectId
- assignedAgentId
- parentTaskId
- title
- description
- status
- priority
- dispatchMode
- notBefore
- idempotencyKey
- codexQueuedSubmissionId
- codexTurnId
- dispatchAttempts
- lastDispatchError
- requestedBy
- resultSummary
- createdAt
- queuedAt
- dispatchedAt
- startedAt
- completedAt
```

`codexQueuedSubmissionId` is integration metadata, not the primary key or product identity.

### 5.2 Task dependency

Introduce explicit task dependencies instead of encoding them in prompts:

```text
TaskDependency
- taskId
- dependsOnTaskId
- type
```

Initial types:

```text
BLOCKS
REQUIRES_SUCCESS
REQUIRES_COMPLETION
```

### 5.3 Queue policy per agent

```text
AgentQueuePolicy
- agentId
- mode
- pausedReason
- maxPendingTasks
- updatedAt
```

Modes:

```text
AUTO
REVIEW_BETWEEN_TASKS
PAUSED
```

Agenticform's configured `maxPendingTasks` should normally be much lower than Codex's current hard limit of 100. The upstream value is an implementation ceiling, not a target backlog size.

## 6. Recommended task state machine

```text
DRAFT
  │ submit
  ▼
QUEUED
  │
  ├──────── dependency unmet ───────► WAITING_DEPENDENCY
  │                                  │ dependency satisfied
  │                                  └───────────────┐
  │                                                  ▼
  ├──────── approval needed ────────► WAITING_APPROVAL
  │                                  │ approved
  │                                  └───────────────┐
  │                                                  ▼
  ├──────── queue paused ───────────► PAUSED
  │                                  │ resumed
  │                                  └───────────────┐
  │                                                  ▼
  └──────── eligible ───────────────► DISPATCHING
                                      │
                                      ├─ Codex queue accepted → DISPATCHED
                                      │                        │ turn starts
                                      │                        ▼
                                      │                      RUNNING
                                      │                        │
                                      │             ┌──────────┴─────────┐
                                      │             ▼                    ▼
                                      │          COMPLETED             FAILED
                                      │
                                      └─ transient failure → QUEUED / retry
```

`BLOCKED` remains useful as a user-visible aggregate state when the task cannot advance and needs intervention, but the internal reason should remain explicit.

## 7. Dispatch algorithm

A first implementation can use PostgreSQL without Kafka/Redis.

Conceptual Java flow:

```java
@Transactional
public Optional<Task> claimNextEligibleTask(UUID agentId) {
    // SELECT ... FOR UPDATE SKIP LOCKED
    // verify queue policy, dependencies, approvals, and task status
    // transition QUEUED -> DISPATCHING
}
```

Then outside the database transaction:

```text
1. Read the target Agent and Codex thread state.
2. Capability-check Codex thread queue support.
3. If thread is unloaded, resume it when policy permits.
4. Re-read thread state after resume.
5. Create a deterministic clientUserMessageId from the Agenticform task id.
6. Call thread/queue/add.
7. Persist codexQueuedSubmissionId and transition to DISPATCHED.
8. Reconcile thread/queue/changed and turn events asynchronously.
```

Do not hold a PostgreSQL transaction open while waiting for Codex network/process I/O.

## 8. Idempotency

This is mandatory because the sequence crosses two persistence systems.

Recommended identity:

```text
clientUserMessageId = "agenticform-task:" + taskId
```

Agenticform should persist delivery attempts and reconcile before retrying an ambiguous timeout.

Ambiguous case:

```text
Agenticform ── thread/queue/add ──► Codex
              response lost
```

A blind retry can duplicate work. Before retrying, list the thread queue and inspect thread history/events for the deterministic client message id where supported.

Agenticform's task remains the authoritative identity even if Codex generates a different queue item id or turn id.

## 9. Wake and reconciliation loop

Because persisted unloaded threads may not auto-wake today, Agenticform needs a small scheduler/reconciler.

It does **not** need to poll aggressively.

Conceptually:

```text
for each active Agent with Agenticform tasks in DISPATCHED:
    read thread state

    if loaded + running:
        do nothing

    if loaded + idle + Codex queue non-empty:
        allow Codex auto-dispatch;
        optionally call queue/start only when explicit recovery is needed

    if not loaded + Codex queue non-empty:
        resume thread
        then re-check state

    if queue item disappeared but no mapped turn/result exists:
        mark RECONCILIATION_REQUIRED
```

The reconciler should also run on Agenticform startup and Codex reconnect.

## 10. Do not confuse queue with steer

These operations represent different intent.

### `turn/steer`

Use when information is relevant to the **currently running task** and should modify/clarify that active turn.

Examples:

- user corrects a requirement
- another agent provides an API detail the current implementation is waiting for
- user says "do not modify that migration"

### `thread/queue/add`

Use when the input is a **separate follow-up unit of work** that should run after the current turn.

Examples:

- after implementation, run tests
- review another branch next
- investigate a second unrelated bug

Agenticform's message/task router must classify this intentionally. Do not make every incoming message a queue item.

## 11. Agent-to-agent routing with queues

Recommended routing policy:

```text
incoming AgentMessage
      │
      ▼
authorize + persist
      │
      ▼
Does target's active task need this message now?
      │
   ┌──┴───┐
  yes     no
   │       │
   ▼       ▼
STEER   create/attach follow-up Task
           │
           ▼
     Agenticform scheduler
           │
           ▼
      Codex thread queue
```

Examples that often qualify for steer:

```text
ANSWER to a question explicitly blocking the current task
critical correction from the user
requested review feedback for the code currently being edited
```

Examples that normally qualify for queue:

```text
new feature request
next investigation
post-implementation test pass
review of a different branch
non-blocking informational follow-up
```

## 12. Approval integration

Agenticform must not pre-dispatch work that is intentionally approval-gated.

Example:

```text
Task: deploy Richmod
status: WAITING_APPROVAL
```

Do not put `deploy Richmod` into the Codex queue until the approval is granted. Otherwise Codex's automatic queue drain could cross the product's safety boundary.

For `REVIEW_BETWEEN_TASKS`, task completion creates or activates a continuation approval before the scheduler dispatches the next task.

## 13. Failure policy

Agenticform should default to fail-closed for the upper queue.

Pause automatic dispatch for an agent when detecting conditions such as:

```text
WAITING_APPROVAL
usage/credit/rate limit that makes immediate retries pointless
Codex disconnected
thread reconciliation mismatch
workspace conflict
repeated dispatch failure
protected operation requiring user action
```

The exact Codex error taxonomy may change, so classify errors through a gateway adapter and retain the raw protocol error for diagnostics.

Do not automatically drain ten more Agenticform tasks because one task failed for an account-wide or environment-wide reason.

## 14. Codex gateway additions

The Java gateway should expose queue semantics without leaking raw JSON-RPC into the rest of the codebase.

```java
public interface CodexGateway {
    CodexThread createThread(CodexThreadSpec spec);
    CodexThread resumeThread(String threadId);
    CodexTurn startTurn(String threadId, CodexInput input);
    void interruptTurn(String threadId, String turnId);
    void steerTurn(String threadId, String turnId, CodexInput input);
    CodexThreadSnapshot readThread(String threadId);

    CodexCapabilities capabilities();

    CodexQueuedSubmission enqueue(String threadId, CodexQueuedInput input);
    List<CodexQueuedSubmission> listQueue(String threadId);
    CodexQueuedSubmission updateQueued(String threadId, String queuedId, CodexQueuedInput input);
    boolean deleteQueued(String threadId, String queuedId);
    void reorderQueue(String threadId, List<String> queuedIds);
    Optional<CodexTurn> startQueuedIfIdle(String threadId, Optional<String> queuedId);
}
```

`CodexCapabilities` should include something like:

```text
threadQueueSupported
threadQueueExperimental
queuePersistenceAvailable
```

If queue support is unavailable, the fallback is Agenticform-only queuing followed by a normal turn start when the thread becomes idle. The product must still work; it just loses Codex-side durable staging.

## 15. Java modules

Add queue-specific responsibilities without creating a distributed-systems framework prematurely:

```text
com.agenticform
├── task
│   ├── TaskQueueService
│   ├── TaskDispatchService
│   ├── TaskDependencyService
│   └── TaskRepository
├── codex
│   ├── CodexGateway
│   ├── CodexQueueAdapter
│   └── CodexQueueReconciler
└── scheduler
    └── AgentDispatchScheduler
```

Recommended single-instance implementation:

- PostgreSQL row locking / `FOR UPDATE SKIP LOCKED`
- Spring scheduler for periodic reconciliation
- event-driven dispatch immediately after meaningful state changes
- no Kafka/NATS/Redis requirement for v1

## 16. Persistence additions

Suggested tables/additions:

```text
tasks
  + dispatch_mode
  + not_before
  + idempotency_key
  + codex_queued_submission_id
  + codex_turn_id
  + dispatch_attempts
  + last_dispatch_error
  + queued_at
  + dispatched_at

task_dependencies
  - task_id
  - depends_on_task_id
  - dependency_type

agent_queue_policies
  - agent_id
  - mode
  - paused_reason
  - max_pending_tasks
  - updated_at

task_dispatch_attempts
  - id
  - task_id
  - attempt
  - request_correlation_id
  - codex_queue_id
  - outcome
  - error_code
  - created_at
```

The attempt table is useful for reconciling ambiguous delivery failures without polluting the main task record.

## 17. API additions

Product-level endpoints should remain independent from Codex RPC names:

```text
GET    /api/agents/{agentId}/queue
POST   /api/agents/{agentId}/queue/pause
POST   /api/agents/{agentId}/queue/resume
PUT    /api/agents/{agentId}/queue/policy
POST   /api/agents/{agentId}/queue/reorder

POST   /api/tasks
PATCH  /api/tasks/{taskId}
POST   /api/tasks/{taskId}/cancel
POST   /api/tasks/{taskId}/dispatch
```

The normal UI should manipulate Agenticform tasks, not raw Codex queue entries. Raw queue IDs belong in an advanced diagnostics/reconciliation view.

## 18. UI changes

### Agent workspace

Add a compact **Next** section near the current task:

```text
Current
  Implement refresh-token fallback                    RUNNING

Next                                         AUTO
  1  Run auth regression tests                        Ready
  2  Answer frontend API contract question            Ready
  3  Review token metrics                              Waiting dependency

[+ Add task] [Pause queue]
```

Do not turn this into a Kanban board by default. It is an ordered execution list.

### Queue controls

For queued tasks that have not started:

- edit
- reorder
- cancel
- hold/release
- inspect dependency/approval reason

For a task already handed to Codex, edits must respect whether the Codex queued submission is still pending. Never present an edit as successful if the underlying turn has already started.

### Queue modes

Expose:

```text
Auto
Review between tasks
Paused
```

`Review between tasks` should make the approval gate visible before the current task completes so the user understands why the next task did not start.

### Diagnostics

Advanced details can show:

```text
Agenticform task id
Codex thread id
Codex queued submission id
Codex turn id
last reconciliation time
last dispatch attempt
```

These are not primary UI labels.

## 19. Example workflow

User creates one backend agent:

```text
Project: richmod
Agent: Backend Auth
Responsibility: Gmail OAuth/token lifecycle
Queue mode: AUTO
```

While it is implementing task A, the user adds B and C:

```text
A RUNNING     implement refresh fallback
B QUEUED      add regression tests       depends on A success
C QUEUED      inspect retry metrics      depends on B completion
```

Agenticform keeps B/C in PostgreSQL.

When A succeeds:

```text
B becomes eligible
Agenticform -> thread/queue/add(B)
Codex returns queuedSubmissionId
Agenticform persists mapping
Codex dispatches B when the thread is idle
```

When B starts, Agenticform maps the turn event to task B.

When B completes, C becomes eligible and follows the same path.

If the Codex thread unloaded before B was dispatched, Agenticform resumes it and reconciles the existing pending queue rather than creating a duplicate instruction.

## 20. What Codex queue should NOT become

It should not become:

- the database for Agenticform tasks
- the dependency graph
- the inter-project authorization system
- the approval engine
- the global scheduler across all agents
- the source of truth for task priority
- a replacement for Agenticform recovery/audit state

Codex queue is an excellent **execution primitive**. Agenticform remains the **orchestrator**.

## 21. Recommended implementation order

### Queue phase 1 — capability + visibility

- enable/detect experimental Codex queue capability
- gateway methods for list/add/start
- consume `thread/queue/changed`
- show queue diagnostics in Agent workspace

### Queue phase 2 — durable Agenticform scheduling

- task dispatch states
- idempotency key
- agent queue policy
- PostgreSQL task claiming
- map queue item -> turn -> task

### Queue phase 3 — recovery

- startup/reconnect reconciliation
- unloaded-thread resume behavior
- ambiguous delivery recovery
- pause on systemic errors

### Queue phase 4 — collaboration

- route non-blocking agent messages into follow-up tasks
- steer only blocking/current-task information
- dependencies between agents
- review-between-tasks mode

## 22. Final design position

Agenticform should integrate Codex's queue early because it substantially improves busy-agent follow-up, inter-agent delivery, ordering, and restart safety.

But the integration boundary should be strict:

```text
Agenticform decides WHAT may run and WHEN it is eligible.
Codex queue decides WHEN an eligible input can safely enter its thread.
Codex turn performs the work.
```

That separation keeps Agenticform useful even if Codex changes or removes its current experimental queue protocol, while still taking advantage of the native queue where available.
