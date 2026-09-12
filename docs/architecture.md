# Agenticform — Initial Architecture

## 1. Purpose

Agenticform is a Java-based control plane for operating multiple Codex agent sessions across applications hosted on the same server.

The product is intended to solve a different problem from a single coding-agent chat. It provides a persistent operating layer above individual Codex threads so that projects, agent responsibilities, workspaces, tasks, messages, approvals, and recovery survive beyond any one UI session.

The core hierarchy is:

```text
Project
  └── Agent
       └── Task
```

Agents may communicate with other agents through Agenticform's message router. They do not communicate by directly attaching to or writing into another Codex thread.

## 2. Goals

Agenticform should:

1. Discover and register multiple applications/repositories on a server.
2. Spawn Codex sessions from the UI with an explicit project, responsibility, and workspace.
3. Keep one logical Agenticform agent mapped to one Codex thread.
4. Support isolated Git worktrees for concurrent implementation agents.
5. Allow agents to send structured messages, questions, handoffs, and review requests to other agents.
6. Support same-project and explicitly permitted cross-project communication.
7. Expose live state in a web UI: working, idle, blocked, waiting for approval, failed, or stopped.
8. Persist enough metadata to reconnect after Agenticform or Codex restarts.
9. Gate sensitive operations such as merge, deploy, destructive commands, or cross-project writes.
10. Keep the system useful for a single server first, without introducing distributed infrastructure prematurely.

## 3. Non-goals for v1

- Fully autonomous production deployment without approval.
- A general-purpose distributed workflow engine.
- Arbitrary shell access to every path on the server.
- Peer-to-peer Codex thread mutation.
- Kafka/NATS-based infrastructure before scale requires it.
- Automatic merging of every agent branch.
- Unlimited recursive agent spawning.

## 4. High-level architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         Web UI                               │
│  Projects · Agents · Tasks · Messages · Approvals · Events │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP + WebSocket/SSE
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    Agenticform Control Plane                 │
│                       Spring Boot / Java                     │
│                                                              │
│  Project Registry          Agent Lifecycle                   │
│  Workspace Manager         Task Coordinator                  │
│  Codex Gateway             Agent Message Router              │
│  Approval Service          Event Stream                      │
│  Permission Policy         Recovery/Reconciliation           │
└───────────────┬──────────────────────┬───────────────────────┘
                │                      │
                │                      └──────────► PostgreSQL
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│                     Codex App Server                         │
│                                                              │
│        Thread A      Thread B      Thread C      ...         │
└───────────────┬────────────┬────────────┬────────────────────┘
                │            │            │
                ▼            ▼            ▼
         worktree A    worktree B    shared/read-only workspace
```

## 5. Main domain objects

### 5.1 Project

A Project represents an application or repository Agenticform is allowed to manage.

```text
Project
- id
- name
- slug
- rootDirectory
- repositoryType
- defaultBranch
- discoveryMode
- enabled
- createdAt
- updatedAt
```

The browser never gets authority to submit an arbitrary filesystem path as a trusted workspace. A project must first exist in the server-side project registry.

### 5.2 Agent

An Agent is the Agenticform representation of one Codex thread plus responsibility and workspace metadata.

```text
Agent
- id
- projectId
- name
- responsibility
- runtimeSessionId
- workspaceMode
- sourceDirectory
- workingDirectory
- branch
- status
- activeTaskId
- activeTurnId
- capabilityProfileId
- createdAt
- updatedAt
```

One Agenticform Agent owns one Codex thread. Multiple UI clients may observe or interact through Agenticform, but they do not become independent writers to the underlying thread.

### 5.3 Task

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
- requestedBy
- resultSummary
- createdAt
- startedAt
- completedAt
```

A task is a unit of work. The Codex thread is the execution context; the task is the control-plane object used to track work.

### 5.4 AgentMessage

```text
AgentMessage
- id
- conversationId
- correlationId
- fromAgentId
- toAgentId
- type
- subject
- content
- hopCount
- status
- createdAt
- deliveredAt
- repliedAt
```

Supported message types in v1:

```text
QUESTION
ANSWER
REQUEST
RESULT
HANDOFF
INFORMATION
BLOCKER
REVIEW_REQUEST
REVIEW_RESULT
```

### 5.5 Approval

```text
Approval
- id
- projectId
- agentId
- taskId
- actionType
- actionPayload
- reason
- status
- requestedAt
- decidedAt
- decidedBy
```

Likely approval-gated actions:

- merge to protected/default branch
- production deploy/restart
- destructive migration
- delete outside an isolated workspace
- permission escalation
- cross-project write

## 6. Project discovery

Agenticform is intended to work with all supported applications on the server, not a hard-coded project list.

Two discovery modes are useful:

### Managed roots

Configuration defines roots that may be scanned:

```yaml
agenticform:
  project-roots:
    - /srv/apps
    - /opt/services
```

Agenticform may detect Git repositories directly under or below those roots and present them as candidates for registration.

### Explicit registration

An operator can register a project discovered from an allowed root.

Security rule: resolve every path to its canonical/real path and verify it remains under an allowed project root before accepting it.

## 7. Agent spawn lifecycle

The UI creates an agent using a request conceptually equivalent to:

```json
{
  "projectId": "richmod",
  "name": "Backend Auth",
  "responsibility": "Own Gmail OAuth, token lifecycle, backend API and tests",
  "workspaceMode": "ISOLATED_WORKTREE",
  "baseBranch": "main",
  "branch": "agent/backend-auth"
}
```

Lifecycle:

```text
UI
 │
 │ POST /api/agents
 ▼
AgentService
 │
 ├─ validate project + capability policy
 ├─ allocate workspace/worktree
 ├─ create Codex thread using workspace cwd
 ├─ establish responsibility/context
 ├─ persist mapping
 └─ publish AGENT_CREATED event
```

Responsibility belongs to Agenticform domain state. The Codex adapter is responsible for converting that responsibility into whatever thread/turn context mechanism is supported by the installed Codex version. Agenticform must not make its database schema depend on one unstable Codex protocol field.

## 8. Workspace strategy

### Isolated worktree — default for writers

```text
/srv/apps/richmod                   source repo
/srv/agenticform/worktrees/
  richmod/
    backend-auth/
    frontend-recurring/
    reviewer-42/
```

Benefits:

- parallel agents cannot change each other's checked-out branch
- Git status is agent-local
- cleanup is deterministic
- branch ownership is explicit

### Shared workspace

Allowed only for intentionally shared/read-mostly agents, for example architecture/research/reviewer workflows where write capability is disabled or tightly constrained.

### Workspace invariants

- Agent workingDirectory must be canonical and inside an approved root.
- Worktree ownership is stored in the database.
- A worktree cannot be attached to two writer agents at once.
- Cleanup is explicit; deleting an Agent record must not silently delete unmerged work.

## 9. Runtime gateway

Runtime integrations are isolated behind an internal `AgentRuntime` port. Codex is the first adapter; protocol changes must not leak into core orchestration.

Persisted agents use `runtimeType` plus opaque `runtimeSessionId`. No provider-specific runtime identity column is persisted.

The Codex adapter remains responsible for transport, thread/turn mapping, event translation, approvals, queue semantics, and reconnect/reconciliation.

The Codex gateway remains the adapter's transport seam:

```java
public interface CodexGateway {
    CodexThread createThread(CodexThreadSpec spec);
    CodexTurn startTurn(String threadId, CodexInput input);
    void interruptTurn(String threadId, String turnId);
    void steerTurn(String threadId, String turnId, CodexInput input);
    CodexThreadSnapshot readThread(String threadId);
}
```

Implementation responsibilities:

- transport connection to Codex App Server
- request/response correlation
- event parsing
- reconnect handling
- protocol version validation
- translating Codex events into Agenticform events

### Request correlation

Asynchronous request handling must not rely on arrival order.

```text
ConcurrentMap<RequestId, CompletableFuture<Response>> pendingRequests
```

### Event translation

Raw Codex events should not be consumed directly by controllers or Telegram/UI adapters.

```text
Codex Event
   ↓
CodexEventAdapter
   ↓
Agenticform Domain Event
   ↓
Event Bus / WebSocket stream / persistence
```

This protects the rest of the application from protocol churn.

## 10. Agent-to-agent communication

Agents communicate through Agenticform, not by manipulating each other's Codex state.

```text
Frontend Agent
    │
    │ QUESTION: confirm GET /transactions response
    ▼
AgentMessageRouter
    │
    ├─ authorization
    ├─ loop/hop protection
    ├─ persist message
    └─ enqueue/deliver
         │
         ▼
Backend Agent
```

When the target agent is idle, the router can start a new turn with an envelope such as:

```text
You received a message from another Agenticform agent.

From: frontend
Type: QUESTION
Subject: Transaction API contract

Message:
Confirm the response schema for GET /transactions.

Respond to the requesting agent with only the information needed to continue.
```

When the target is busy, the message stays queued unless the message type/policy allows steering the active turn.

### Loop protection

Every routed conversation has:

- `conversationId`
- `correlationId`
- `hopCount`
- configured maximum hop count
- optional per-conversation message budget

Exceeding the budget changes the conversation to `ESCALATED` and asks for user intervention rather than letting two agents ping-pong indefinitely.

## 11. Cross-project communication

Default policy:

```text
same project: allowed
cross-project read/message: deny unless explicitly allowed
cross-project write: approval required
```

Example policy model:

```yaml
communication:
  same-project: true
  cross-project:
    - from: richmod
      to: auth-service
      actions: [MESSAGE]
    - from: status-page
      to: infra
      actions: [MESSAGE, READ]
```

This policy belongs to Agenticform, not to agent prompts alone.

## 12. Capability model

Example capabilities:

```text
READ
WRITE
TEST
COMMIT
MESSAGE
REVIEW
MERGE
DEPLOY
```

Suggested profiles:

```text
IMPLEMENTER
  READ WRITE TEST COMMIT MESSAGE

REVIEWER
  READ TEST REVIEW MESSAGE

ARCHITECT
  READ MESSAGE

OPS
  READ TEST MESSAGE DEPLOY (approval-gated)
```

Prompt instructions are not a security boundary. Filesystem/process permissions and Agenticform authorization must enforce capability restrictions where possible.

## 13. Java backend modules

Recommended initial package structure:

```text
com.agenticform
├── project
│   ├── ProjectController
│   ├── ProjectService
│   ├── ProjectRepository
│   └── ProjectDiscoveryService
├── agent
│   ├── AgentController
│   ├── AgentService
│   ├── AgentRepository
│   └── AgentLifecycleService
├── task
│   ├── TaskController
│   ├── TaskService
│   └── TaskRepository
├── codex
│   ├── CodexGateway
│   ├── CodexAppServerGateway
│   ├── CodexEventAdapter
│   └── CodexConnectionManager
├── workspace
│   ├── WorkspaceManager
│   └── GitWorktreeService
├── message
│   ├── AgentMessageRouter
│   ├── AgentMailboxService
│   └── AgentMessageRepository
├── approval
│   ├── ApprovalController
│   ├── ApprovalService
│   └── ApprovalRepository
├── policy
│   ├── CapabilityPolicy
│   └── CommunicationPolicy
└── event
    ├── DomainEvent
    ├── EventPublisher
    └── LiveEventController
```

## 14. Persistence

PostgreSQL is sufficient for v1.

Suggested tables:

```text
projects
agents
tasks
agent_messages
agent_message_conversations
approvals
workspaces
agent_events
capability_profiles
communication_rules
```

Do not use an in-memory `ConcurrentHashMap` as the source of truth. In-memory maps are fine for active connection/request correlation state only.

## 15. Concurrency model

The first version does not need Kafka, Redis Streams, or NATS.

Use:

- PostgreSQL for durable state
- Java concurrency primitives for active Codex request correlation
- bounded executors / virtual threads where appropriate to the chosen Java version
- Spring application/domain events for process-local fanout
- WebSocket or SSE for UI updates

Introduce a broker only if multiple Agenticform backend instances become a real requirement.

## 16. Recovery and reconciliation

On startup:

```text
1. Load agents marked active/non-terminal.
2. Reconnect to Codex App Server.
3. Inspect known thread IDs where supported.
4. Reconcile each Agent:
   - thread reachable + no active turn → IDLE
   - thread reachable + active work → WORKING
   - thread not reachable → DISCONNECTED
5. Never silently create a replacement thread for an existing Agent.
6. Surface reconciliation failures in the UI.
```

Persistent Agent IDs remain stable even if an operator later chooses to replace the associated Codex thread.

## 17. API surface — initial proposal

```text
GET    /api/projects
POST   /api/projects/scan
POST   /api/projects
GET    /api/projects/{projectId}

GET    /api/agents
POST   /api/agents
GET    /api/agents/{agentId}
POST   /api/agents/{agentId}/messages
POST   /api/agents/{agentId}/interrupt
POST   /api/agents/{agentId}/stop

GET    /api/tasks
POST   /api/tasks
POST   /api/tasks/{taskId}/assign

GET    /api/messages
GET    /api/conversations/{conversationId}

GET    /api/approvals
POST   /api/approvals/{id}/approve
POST   /api/approvals/{id}/reject

GET    /api/events/stream
```

This is a product-level API proposal, not a commitment to mirror Codex protocol names one-to-one.

## 18. Status model

Agent status:

```text
STARTING
IDLE
WORKING
WAITING_MESSAGE
WAITING_APPROVAL
BLOCKED
DISCONNECTED
FAILED
STOPPED
```

Task status:

```text
QUEUED
RUNNING
BLOCKED
WAITING_APPROVAL
COMPLETED
FAILED
CANCELLED
```

## 19. Security baseline

- Bind Codex App Server to a private/local interface unless there is a concrete reason not to.
- Do not expose Codex transport directly to the browser.
- Canonicalize all filesystem paths.
- Maintain an allowlist of project roots.
- Store no secrets in agent responsibilities or message history when avoidable.
- Redact known secret patterns from logs/event previews.
- Require explicit capability and policy checks for cross-project operations.
- Keep merge/deploy/destructive actions approval-gated initially.
- Record an audit event for sensitive state changes.

## 20. UI relationship

The UI is a control surface for this domain model. It is not a terminal skin.

Primary screens:

1. Project overview
2. Project detail / agent roster
3. Agent workspace
4. Spawn agent flow
5. Cross-agent conversations
6. Approvals inbox
7. Activity/event timeline

The visual and interaction specification is defined in [`ui-ux.md`](./ui-ux.md).

## 21. Delivery phases

### Phase 1 — control plane foundation

- Spring Boot application
- PostgreSQL schema
- project registry/discovery
- Codex connection/gateway
- spawn/resume/stop one agent
- live events to UI

### Phase 2 — isolated execution

- Git worktree manager
- responsibility/capability profiles
- task model
- recovery/reconciliation

### Phase 3 — agent collaboration

- mailbox/message router
- same-project communication
- question/answer correlation
- loop limits and escalation

### Phase 4 — approvals and cross-project policy

- approval inbox
- communication rules
- sensitive capability gates
- cross-project messages

### Phase 5 — higher-level orchestration

- supervisor/coordinator agents
- dependency-aware task dispatch
- reviewer handoffs
- optional merge/deploy integrations

## 22. Architectural decisions

Initial decisions:

1. **Java/Spring Boot control plane** — requested platform and appropriate for persistent service orchestration.
2. **PostgreSQL source of truth** — durable state before introducing a message broker.
3. **One Agenticform agent → one Codex thread** — simple ownership and recovery semantics.
4. **Agent communication through Agenticform** — observable, permissioned, loop-limited collaboration.
5. **Git worktree isolation by default for writer agents** — avoids concurrent workspace collisions.
6. **Project registry, not arbitrary browser paths** — filesystem security boundary.
7. **Codex integration behind a gateway** — avoids coupling the domain model to Codex protocol churn.
8. **Human approval for sensitive actions in early versions** — safer default while policies mature.
