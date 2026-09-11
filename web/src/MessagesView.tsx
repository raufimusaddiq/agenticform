import { FormEvent, useMemo, useState } from 'react';
import type { Agent, AgentMessage, AgentMessageType, Project } from './types';
import './messages.css';

const messageTypes: AgentMessageType[] = [
  'QUESTION', 'ANSWER', 'REQUEST', 'RESULT', 'HANDOFF',
  'REVIEW_REQUEST', 'REVIEW_RESULT', 'INFORMATION', 'BLOCKER'
];

const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const shortId = (value: string | null) => (value ? `${value.slice(0, 8)}…` : '—');

export function MessagesView({ messages, agents, projects, onSend }: {
  messages: AgentMessage[];
  agents: Agent[];
  projects: Project[];
  onSend: (input: {
    fromAgentId: string;
    toAgentId: string;
    type: AgentMessageType;
    subject: string;
    content: string;
  }) => Promise<void>;
}) {
  const [fromAgentId, setFromAgentId] = useState(agents[0]?.id ?? '');
  const source = agents.find((agent) => agent.id === fromAgentId) ?? agents[0];
  const targets = useMemo(
    () => agents.filter((agent) => agent.projectId === source?.projectId && agent.id !== source?.id),
    [agents, source]
  );
  const [toAgentId, setToAgentId] = useState('');
  const [type, setType] = useState<AgentMessageType>('INFORMATION');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = toAgentId || targets[0]?.id;
    if (!source || !target) return;
    setSending(true);
    try {
      await onSend({ fromAgentId: source.id, toAgentId: target, type, subject, content });
      setSubject('');
      setContent('');
    } finally {
      setSending(false);
    }
  };

  return <div className="page-stack messages-layout">
    <section className="panel">
      <div className="section-header">
        <div><p className="eyebrow">Durable mailbox</p><h2>Agent messages</h2></div>
        <span className="muted">{messages.length} messages</span>
      </div>
      {!messages.length ? <div className="empty"><strong>No agent messages yet</strong><p>Messages sent through native Codex dynamic tools will appear here.</p></div> : <div className="data-list">
        {[...messages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((message) => {
          const from = agentById.get(message.fromAgentId);
          const to = agentById.get(message.toAgentId);
          return <article className="message-row" key={message.id}>
            <div className="message-meta">
              <div><strong>{message.subject}</strong><small>{projectById.get(message.projectId)?.name ?? 'Unknown project'}</small></div>
              <span className={`message-type message-type-${message.type.toLowerCase()}`}>{label(message.type)}</span>
              <span className={`status status-${message.status.toLowerCase()}`}><span className="status-dot" />{label(message.status)}</span>
            </div>
            <p className="message-route"><strong>{from?.name ?? shortId(message.fromAgentId)}</strong><span>→</span><strong>{to?.name ?? shortId(message.toAgentId)}</strong><span>· hop {message.hopCount}/6</span></p>
            <p className="message-body">{message.content}</p>
            <div className="message-machine"><code>message {shortId(message.id)}</code><code>conversation {shortId(message.conversationId)}</code><code>queue {shortId(message.codexQueuedSubmissionId)}</code><code>turn {shortId(message.codexTurnId)}</code></div>
            {message.lastError && <p className="inline-error">{message.lastError}</p>}
          </article>;
        })}
      </div>}
    </section>

    <section className="panel compose-panel">
      <div className="section-header"><div><p className="eyebrow">Manual relay</p><h2>Send message</h2></div></div>
      {!agents.length ? <div className="empty"><strong>No agents available</strong><p>Spawn agents before using the mailbox.</p></div> : <form onSubmit={submit}>
        <div className="form-grid">
          <label>From agent<select value={source?.id ?? ''} onChange={(event) => { setFromAgentId(event.target.value); setToAgentId(''); }}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select></label>
          <label>To agent<select required value={toAgentId || targets[0]?.id || ''} onChange={(event) => setToAgentId(event.target.value)} disabled={!targets.length}>
            {targets.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {label(agent.status)}</option>)}
          </select></label>
        </div>
        <label>Type<select value={type} onChange={(event) => setType(event.target.value as AgentMessageType)}>{messageTypes.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <label>Subject<input required value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="API contract ready" /></label>
        <label>Message<textarea required rows={6} value={content} onChange={(event) => setContent(event.target.value)} placeholder="Share only the context the receiving agent needs." /></label>
        <p className="form-note">Cross-project messages are intentionally blocked until Agenticform has an explicit permission policy.</p>
        <footer className="form-actions"><button className="button primary" disabled={sending || !targets.length}>{sending ? 'Sending…' : 'Send message'}</button></footer>
      </form>}
    </section>
  </div>;
}
