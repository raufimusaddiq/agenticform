# Agenticform — UI/UX Specification

## 1. Design read

Reading this as: a developer control-plane product for operating multiple coding agents across several server-hosted applications, with a restrained technical SaaS language, high information density, strong hierarchy, and minimal ornamental motion.

Agenticform is a product dashboard, not a marketing landing page. The referenced Taste Skill explicitly scopes its main skill away from dashboards/data tables/multi-step product UI, so this specification does **not** apply that skill mechanically. Instead, it adopts the parts that remain useful for a product surface:

- anti-default / anti-slop discipline
- deliberate typography and spacing
- one-accent color discipline
- consistent icon family
- motion only where it communicates state
- avoid generic glassmorphism, purple AI gradients, excessive card grids, fake terminal decoration, and template-looking UI
- maintain clear visual rhythm and hierarchy

Reference: `Leonxlnx/taste-skill`, especially `skills/taste-skill/SKILL.md`.

## 2. Design dials

Adapted for a dense developer tool:

```text
DESIGN_VARIANCE:   5
MOTION_INTENSITY:  3
VISUAL_DENSITY:    7
```

Rationale:

- Variance 5: enough asymmetry and hierarchy to avoid generic admin-template appearance, without compromising scanability.
- Motion 3: status transitions and panel changes only; no decorative animation loops.
- Density 7: this is an operations/control interface where users need to compare projects, agents, tasks, messages, and approvals quickly.

## 3. Product principles

### 3.1 Operational state first

The first question the UI must answer is:

> What is running, blocked, waiting for me, or broken right now?

Project and agent states must be visible without opening every detail view.

### 3.2 Responsibility is a primary label

An agent name alone is insufficient. Responsibility must remain visible in lists and detail views so users know what each Codex thread owns.

### 3.3 No terminal cosplay

The application may show command output and event logs, but the overall UI must not mimic a terminal for aesthetics. Use terminal/monospace treatment only for actual machine content:

- paths
- branches
- commands
- logs
- IDs
- code snippets

### 3.4 Progressive disclosure

Dense information should be available without showing every detail simultaneously.

Default overview: state, responsibility, project, task, workspace, last activity.

Expanded/detail views: full message history, raw events, IDs, worktree metadata, protocol errors.

### 3.5 State uses more than color

Every status has:

- text label
- icon or shape
- optional color token

Color alone is never the only state signal.

## 4. Information architecture

Primary navigation:

```text
Agenticform

Overview
Projects
Agents
Tasks
Messages
Approvals
Activity

Settings
```

Recommended desktop shell:

```text
┌──────────────────────────────────────────────────────────────┐
│ Sidebar │ Top context bar                                   │
│         ├────────────────────────────────────────────────────│
│         │                                                    │
│         │ Main workspace                                     │
│         │                                                    │
│         │                                                    │
└──────────────────────────────────────────────────────────────┘
```

The sidebar stays narrow and stable. Do not create a second permanent side rail unless the active screen truly requires it.

## 5. Overview screen

Purpose: server-wide operational awareness.

Suggested structure:

```text
Agenticform                                           [Spawn agent]
Control plane / server-name

Needs attention
┌───────────────┬───────────────┬───────────────┐
│ 2 approvals   │ 1 blocked     │ 1 disconnected│
└───────────────┴───────────────┴───────────────┘

Active projects

Richmod                                3 agents · 1 working
Backend Auth       WORKING             Gmail OAuth / token lifecycle
Frontend           IDLE                Product UI
Reviewer           WAITING_APPROVAL    Review auth changes

Status Page                            2 agents · healthy
Backend            IDLE
Frontend           WORKING

Recent activity
13:41  richmod/backend-auth  started task "refresh-token fallback"
13:38  status-page/frontend  completed turn
13:35  reviewer              requested merge approval
```

Do not make summary metrics giant KPI cards. They are operational shortcuts, not business analytics.

## 6. Projects screen

Projects are server applications registered with Agenticform.

List columns/content:

```text
Project
Path
Default branch
Agents
Active tasks
Health
Last activity
```

A project row should support expansion or navigation to detail.

Actions:

- scan allowed roots
- register discovered project
- disable project
- open project detail

Filesystem paths use monospace and secondary visual prominence.

## 7. Project detail

Header:

```text
Richmod
/srv/apps/richmod
main

[Spawn agent] [Project settings]
```

Sections/tabs:

```text
Agents
Tasks
Messages
Workspaces
Activity
```

### Agent roster

Prefer a structured list over a repeated grid of generic cards.

```text
NAME            STATUS       RESPONSIBILITY                  TASK
Backend Auth    Working      OAuth / token lifecycle        Refresh fallback
Frontend        Idle         Product UI                     —
Reviewer        Waiting      Cross-agent review             Review #18
```

Each row can reveal workspace/branch metadata on expansion.

## 8. Spawn Agent flow

This is one of the most important product interactions.

Use a focused sheet/modal or dedicated flow, not a tiny generic dialog.

Fields:

```text
Project
  Richmod

Name
  Backend Auth

Responsibility
  Own Gmail OAuth, token lifecycle, backend API, and tests.

Capability profile
  Implementer

Workspace
  ● Isolated worktree (recommended)
  ○ Shared project directory

Base branch
  main

Agent branch
  agent/backend-auth

Advanced
  Model / reasoning configuration
  Communication policy overrides
```

Footer:

```text
Cancel                                      Spawn agent
```

### Responsibility templates

Allow templates but never hide the resolved responsibility text.

Suggested templates:

- Backend Engineer
- Frontend Engineer
- Reviewer
- QA / Test Engineer
- Architect / Research
- Ops

Selecting a template pre-fills editable responsibility text and capability profile.

## 9. Agent workspace

The Agent workspace is the core interaction screen.

Desktop layout:

```text
┌──────────────────────────────────────────────────────────────────┐
│ Backend Auth / Richmod          WORKING          [Interrupt] [...]│
│ Gmail OAuth, token lifecycle, backend API and tests              │
├───────────────────────────────────────┬──────────────────────────┤
│                                       │ Context                  │
│ Conversation / task stream            │                          │
│                                       │ Project: Richmod        │
│ User / other agent messages           │ Branch: agent/auth      │
│ Agent output                           │ Workspace: isolated     │
│ Tool/action summaries                 │ Task: Refresh fallback  │
│ Approval requests                     │                          │
│                                       │ Mailbox                  │
│                                       │ 2 unread                │
├───────────────────────────────────────┴──────────────────────────┤
│ Message agent…                                      [Send]      │
└──────────────────────────────────────────────────────────────────┘
```

The right context rail is contextual and collapsible. It is not a second global navigation sidebar.

### Stream item types

Visually distinguish:

- user instruction
- agent response
- tool/action summary
- message from another agent
- message sent to another agent
- approval request
- system/recovery event
- error

Avoid placing every event inside a bordered card. Use spacing, typography, subtle separators, and status chips so the timeline remains readable.

## 10. Inter-agent messaging UI

Messages should make direction and correlation obvious.

Example:

```text
Frontend → Backend Auth
QUESTION · API Contract

Confirm the response schema for GET /transactions.

13:24
```

Reply:

```text
Backend Auth → Frontend
ANSWER · API Contract

GET /transactions returns ...

13:27
```

Conversation detail displays:

- participating agents
- project boundaries
- message type
- subject
- correlation/conversation metadata in advanced details
- escalation state if loop budget is reached

## 11. Messages screen

This is an operational mailbox, not a social chat app.

Filters:

```text
All
Questions
Handoffs
Reviews
Blockers
Cross-project
```

Rows:

```text
TYPE       FROM                TO                  SUBJECT               STATE
Question   richmod/frontend    richmod/backend     API contract          Answered
Blocker    status/ops          status/backend      health endpoint       Open
Review     richmod/backend     richmod/reviewer    auth changes          Pending
```

Unread and unresolved states matter more than chronological chatter.

## 12. Approvals screen

Approvals deserve a dedicated inbox because they are user-action bottlenecks.

```text
Approvals                                             3 pending

MERGE
Richmod / Reviewer
Merge agent/backend-auth → main
Reason: review completed, tests passing

[View diff/context]                         [Reject] [Approve]
```

Sensitive details should be visible before the primary action.

Approval actions must never be represented by ambiguous icon-only buttons.

## 13. Activity screen

A chronological, filterable audit/event stream.

Filters:

- project
- agent
- task
- status
- event type
- time range

Events should be compact:

```text
13:41:08  WORKING   richmod/backend-auth   turn started
13:40:51  MESSAGE   richmod/frontend       question → backend-auth
13:39:17  APPROVAL  richmod/reviewer       merge approval requested
```

Raw payload is hidden behind an expandable detail view.

## 14. Status vocabulary and tokens

Recommended semantic states:

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

Visual intent:

- Idle: neutral
- Working: active accent
- Waiting approval: attention/warning
- Blocked: warning/error-adjacent
- Disconnected/Failed: destructive/error
- Stopped: muted

Do not use nine unrelated bright colors. Several states can share a color family and remain differentiated through icon + label.

## 15. Typography

Target language: technical, neutral, modern.

Recommended:

```text
Primary sans: Geist / system fallback
Monospace: Geist Mono / system monospace fallback
```

Use the monospace family only for machine identifiers and code-adjacent content.

Hierarchy should come from size, weight, whitespace, and grouping rather than excessive all-caps labels.

Avoid serif display type; it is not justified by this product category.

## 16. Color system

Use a neutral base with one accent.

Suggested direction:

```text
Base: zinc / graphite neutrals
Accent: restrained blue or cyan-blue
Success: semantic green
Warning: semantic amber
Danger: semantic red
```

The accent is reserved for:

- primary actions
- active navigation
- working/live state emphasis
- focus rings
- selected items

Avoid purple/blue AI glow gradients and decorative neon effects.

Dark mode should be designed intentionally rather than generated by simple color inversion.

## 17. Shape, borders, and elevation

- Moderate radius; avoid oversized rounded everything.
- Use borders and background contrast before shadows.
- Shadows should communicate layering (popover/sheet/modal), not decorate every container.
- Dense tables/lists should use subtle row separation rather than card-per-row.

## 18. Iconography

Use one icon family across the product.

Preferred candidate: Phosphor Icons.

Icons supplement labels; they do not replace critical action text.

Examples:

```text
Projects       folder/repository
Agents         robot/terminal-window equivalent from chosen family
Tasks          check-square
Messages       arrows-left-right/chat
Approvals      shield-check
Activity       pulse/activity
Settings       gear
```

Final icon names depend on the selected library. Do not hand-draw SVG paths for common UI icons.

## 19. Motion

MOTION_INTENSITY = 3.

Allowed:

- 120–200 ms panel/hover transitions
- small status indicator transition when an agent changes state
- sheet/dialog entrance
- list insertion/removal
- skeleton/loading transitions

Avoid:

- looping ambient animations
- bouncing AI indicators
- animated gradients
- excessive spring physics
- typing animations for already-received text

For live Codex output, append/stream content naturally; do not add artificial typewriter effects.

## 20. Empty states

Empty states should be actionable and product-specific.

Example Projects empty state:

```text
No projects registered

Scan an allowed server root to find Git repositories that Agenticform can manage.

[Scan project roots]
```

Example Agents empty state:

```text
No agents in Richmod

Spawn an agent with a defined responsibility and isolated workspace.

[Spawn agent]
```

Avoid decorative illustrations unless they add real meaning.

## 21. Error states

Errors must answer:

1. What failed?
2. What is affected?
3. Is user action required?
4. Can Agenticform retry safely?

Example:

```text
Backend Auth disconnected from its Codex thread.

The workspace is unchanged. Agenticform could not reconcile thread 019c… after reconnecting to Codex App Server.

[Retry reconciliation] [View details]
```

## 22. Responsive behavior

Primary target is desktop because server/application orchestration benefits from horizontal space.

Still support smaller screens:

- sidebar collapses to drawer
- tables become structured stacked rows
- agent context rail becomes a drawer/sheet
- approvals retain full action labels
- no forced desktop-width horizontal scrolling for primary flows

Do not simplify mobile by removing safety-critical context.

## 23. Accessibility

Baseline requirements:

- visible keyboard focus
- WCAG-appropriate text/background contrast
- all status states represented by text, not color only
- fully keyboard-operable navigation and dialogs
- reduced-motion preference respected
- semantic headings and table markup where tables are used
- icon buttons always have accessible names/tooltips
- live-stream output should avoid overly noisy screen-reader announcements; announce meaningful completion/state changes rather than every token delta

## 24. Frontend implementation direction

Recommended stack for the implementation phase:

```text
Next.js or React
TypeScript
Tailwind CSS
Radix primitives or customized shadcn/ui primitives
Phosphor Icons
WebSocket or SSE client for live state
```

If shadcn/ui is used, components must be customized to Agenticform tokens and density. Do not ship stock shadcn visual defaults unchanged.

The UI should consume Agenticform domain APIs. It must never connect directly to Codex App Server.

## 25. Core component inventory

```text
AppShell
SidebarNav
ProjectSelector
ProjectStatusRow
AgentStatusRow
AgentStatusBadge
ResponsibilitySummary
TaskStatusBadge
WorkspaceBadge
SpawnAgentSheet
AgentConversation
AgentStreamItem
AgentContextPanel
AgentMailbox
AgentMessageItem
ApprovalItem
ActivityTimeline
FilterBar
DataTable
EmptyState
ErrorState
ConfirmSensitiveActionDialog
```

Do not create one-off components for every screen when a domain-level component can be reused.

## 26. UI event model

Live events should update the UI by domain object, not force full-page refreshes.

Examples:

```text
AGENT_STATUS_CHANGED
AGENT_OUTPUT_APPENDED
TASK_STATUS_CHANGED
MESSAGE_RECEIVED
APPROVAL_REQUESTED
APPROVAL_RESOLVED
WORKSPACE_CHANGED
RECONCILIATION_FAILED
```

The client may keep a normalized cache keyed by project/agent/task IDs.

## 27. Pre-flight design checklist

Before a UI change is accepted:

- Does the screen make current state obvious within a few seconds?
- Is responsibility visible wherever an agent identity matters?
- Are we using a list/table where repeated cards would waste space?
- Is there only one accent color family?
- Does motion communicate state rather than decorate?
- Is any terminal styling showing real terminal/code content?
- Can waiting approvals and blockers be found immediately?
- Are destructive/sensitive actions explicit and labeled?
- Can the design survive both light and dark themes?
- Does the page look like Agenticform rather than a generic AI dashboard template?
