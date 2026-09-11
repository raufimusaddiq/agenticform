import { FormEvent, useMemo, useState } from 'react';
import type {
  Agent,
  HumanApproval,
  HumanApprovalDecision,
  Project
} from './types';

const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const shortId = (value: string | null) => (value ? `${value.slice(0, 8)}…` : '—');

type UserQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export function ApprovalsView({ approvals, agents, projects, onDecision, onAnswer }: {
  approvals: HumanApproval[];
  agents: Agent[];
  projects: Project[];
  onDecision: (id: string, decision: HumanApprovalDecision) => Promise<void>;
  onAnswer: (id: string, answers: Record<string, string[]>) => Promise<void>;
}) {
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const pending = approvals.filter((approval) => approval.status === 'PENDING');
  const history = approvals.filter((approval) => approval.status !== 'PENDING');

  return <div className="page-stack">
    <section className="control-mode-note">
      <div><strong>Human-in-the-loop</strong><span>Every Codex approval waits for you.</span></div>
      <div><strong>Human-on-the-loop</strong><span>Low-risk workspace actions can continue automatically; escalations still stop.</span></div>
    </section>

    <section className="panel">
      <div className="section-header">
        <div><p className="eyebrow">Needs a human</p><h2>Pending approvals</h2></div>
        <span className="approval-count">{pending.length}</span>
      </div>
      {!pending.length ? <div className="empty"><strong>No pending approvals</strong><p>Escalated Codex actions and user-input requests will appear here.</p></div> :
        <div className="approval-list">{pending.map((approval) =>
          <ApprovalCard key={approval.id} approval={approval} agent={agentById.get(approval.agentId)} project={projectById.get(approval.projectId)} onDecision={onDecision} onAnswer={onAnswer} />
        )}</div>}
    </section>

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Human control audit</p><h2>Decision history</h2></div></div>
      {!history.length ? <div className="empty"><strong>No approval history yet</strong><p>Manual and HOTL auto-approvals are retained here for review.</p></div> :
        <div className="approval-history">{history.slice(0, 100).map((approval) => {
          const agent = agentById.get(approval.agentId);
          return <div className="approval-history-row" key={approval.id}>
            <div><strong>{approval.summary}</strong><small>{projectById.get(approval.projectId)?.name} / {agent?.name ?? shortId(approval.agentId)}</small></div>
            <span className={`risk risk-${approval.risk.toLowerCase()}`}>{label(approval.risk)}</span>
            <span className="mode-pill">{approval.controlMode === 'IN_THE_LOOP' ? 'HITL' : 'HOTL'}</span>
            <span className={`status status-${approval.status.toLowerCase()}`}><span className="status-dot" />{label(approval.status)}</span>
            <time>{new Date(approval.resolvedAt ?? approval.createdAt).toLocaleString()}</time>
          </div>;
        })}</div>}
    </section>
  </div>;
}

function ApprovalCard({ approval, agent, project, onDecision, onAnswer }: {
  approval: HumanApproval;
  agent?: Agent;
  project?: Project;
  onDecision: (id: string, decision: HumanApprovalDecision) => Promise<void>;
  onAnswer: (id: string, answers: Record<string, string[]>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const payload = parsePayload(approval.requestPayload);

  const decide = async (decision: HumanApprovalDecision) => {
    setBusy(true);
    try { await onDecision(approval.id, decision); } finally { setBusy(false); }
  };

  return <article className="approval-card">
    <header className="approval-card-header">
      <div>
        <div className="approval-title-line"><strong>{approval.summary}</strong><span className={`risk risk-${approval.risk.toLowerCase()}`}>{label(approval.risk)}</span></div>
        <small>{project?.name ?? 'Unknown project'} / {agent?.name ?? shortId(approval.agentId)}</small>
      </div>
      <div className="approval-badges"><span className="mode-pill">{approval.controlMode === 'IN_THE_LOOP' ? 'HITL' : 'HOTL escalation'}</span><span>{label(approval.type)}</span></div>
    </header>

    <ApprovalDetails approval={approval} payload={payload} agent={agent} />

    {approval.type === 'USER_INPUT'
      ? <UserInputForm approval={approval} payload={payload} busy={busy} onSubmit={async (answers) => { setBusy(true); try { await onAnswer(approval.id, answers); } finally { setBusy(false); } }} />
      : <footer className="approval-actions">
          <button className="button primary" disabled={busy} onClick={() => void decide('APPROVE_ONCE')}>Approve once</button>
          <button className="button secondary" disabled={busy} onClick={() => void decide('APPROVE_SESSION')}>Approve session</button>
          <button className="button danger" disabled={busy} onClick={() => void decide('DECLINE')}>Decline</button>
        </footer>}
  </article>;
}

function ApprovalDetails({ approval, payload, agent }: { approval: HumanApproval; payload: Record<string, unknown>; agent?: Agent }) {
  const command = text(payload.command);
  const cwd = text(payload.cwd);
  const reason = text(payload.reason);
  const grantRoot = text(payload.grantRoot);
  const permissions = payload.permissions;

  return <div className="approval-details">
    {reason && <div><span>Reason</span><p>{reason}</p></div>}
    {command && <div><span>Command</span><code className="approval-command">{command}</code></div>}
    {cwd && <div><span>Working directory</span><code>{cwd}</code></div>}
    {grantRoot && <div><span>Requested write root</span><code>{grantRoot}</code></div>}
    {permissions != null && <div><span>Requested permissions</span><pre>{JSON.stringify(permissions, null, 2)}</pre></div>}
    <div className="approval-machine"><code>thread {shortId(approval.threadId)}</code><code>turn {shortId(approval.turnId)}</code><code>item {shortId(approval.itemId)}</code>{agent && <code>workspace {agent.workingDirectory}</code>}</div>
  </div>;
}

function UserInputForm({ approval, payload, busy, onSubmit }: {
  approval: HumanApproval;
  payload: Record<string, unknown>;
  busy: boolean;
  onSubmit: (answers: Record<string, string[]>) => Promise<void>;
}) {
  const questions = Array.isArray(payload.questions) ? payload.questions as UserQuestion[] : [];
  const [values, setValues] = useState<Record<string, string>>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const answers: Record<string, string[]> = {};
    questions.forEach((question) => { answers[question.id] = [values[question.id] ?? '']; });
    void onSubmit(answers);
  };

  return <form className="user-input-form" onSubmit={submit}>
    {questions.map((question) => <label key={question.id}>
      <span><strong>{question.header}</strong><small>{question.question}</small></span>
      {question.options?.length
        ? <select required value={values[question.id] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}>
            <option value="">Choose an answer</option>
            {question.options.map((option) => <option key={option.label} value={option.label}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}
          </select>
        : <input required type={question.isSecret ? 'password' : 'text'} value={values[question.id] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))} />}
    </label>)}
    {!questions.length && <p className="inline-error">Codex supplied no structured questions. Inspect request {shortId(approval.codexRequestId)}.</p>}
    <footer className="approval-actions"><button className="button primary" disabled={busy || !questions.length}>Send answer</button></footer>
  </form>;
}

function parsePayload(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}
