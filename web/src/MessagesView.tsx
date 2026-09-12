import { FormEvent, useMemo, useState } from 'react';
import type { Agent, AgentMessage, AgentMessageType, CommunicationRule, Project } from './types';
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
  communicationRules: CommunicationRule[];
  onSend: (input: {
    fromAgentId: string;
    toAgentId: string;
    type: AgentMessageType;
    subject: string;
    content: string;
    replyToMessageId?: string;
  }) => Promise<void>;
  onSaveRule: (input: { fromProjectId: string; toProjectId: string; effect: 'ALLOW' | 'DENY'; enabled: boolean }) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
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
  const [replyTo, setReplyTo] = useState<AgentMessage | null>(null);
  const [ruleFrom, setRuleFrom] = useState(projects[0]?.id ?? '');
  const [ruleTo, setRuleTo] = useState(projects[1]?.id ?? '');
  const [ruleEffect, setRuleEffect] = useState<'ALLOW' | 'DENY'>('ALLOW');
  const conversations = useMemo(() => {
    const grouped = new Map<string, AgentMessage[]>();
    messages.forEach((message) => grouped.set(message.conversationId, [...(grouped.get(message.conversationId) ?? []), message]));
    return [...grouped.entries()].sort((a, b) => Date.parse(b[1][b[1].length - 1].createdAt) - Date.parse(a[1][a[1].length - 1].createdAt));
  }, [messages]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = toAgentId || targets[0]?.id;
    if (!source || !target) return;
    setSending(true);
    try {
      await onSend({ fromAgentId: source.id, toAgentId: target, type, subject, content, replyToMessageId: replyTo?.id });
      setSubject('');
      setContent('');
      setReplyTo(null);
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
          const to = message.toAgentId ? agentById.get(message.toAgentId) : undefined;
          const targetLabel = to?.name ?? (message.toAgentId ? shortId(message.toAgentId) : label(message.audienceType));
          return <article className="message-row" key={message.id}>
            <div className="message-meta">
              <div><strong>{message.subject}</strong><small>{projectById.get(message.projectId)?.name ?? 'Unknown project'}</small></div>
              <span className={`message-type message-type-${message.type.toLowerCase()}`}>{label(message.type)}</span>
              <span className={`status status-${message.status.toLowerCase()}`}><span className="status-dot" />{label(message.status)}</span>
            </div>
            <p className="message-route"><strong>{from?.name ?? shortId(message.fromAgentId)}</strong><span>→</span><strong>{targetLabel}</strong><span>· hop {message.hopCount}/6</span></p>
            <p className="message-body">{message.content}</p>
            <button className="button ghost" type="button" onClick={() => { setReplyTo(message); setFromAgentId(message.toAgentId ?? source?.id ?? ''); setToAgentId(message.fromAgentId); }}>Reply</button>
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
        {replyTo && <p className="form-note">Replying to <code>{shortId(replyTo.id)}</code>. <button className="button ghost" type="button" onClick={() => setReplyTo(null)}>Clear</button></p>}
        <label>Subject<input required value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="API contract ready" /></label>
        <label>Message<textarea required rows={6} value={content} onChange={(event) => setContent(event.target.value)} placeholder="Share only the context the receiving agent needs." /></label>
        <p className="form-note">Cross-project messages are intentionally blocked. Agent fanout is available to Codex through the durable broadcast tool.</p>
        <footer className="form-actions"><button className="button primary" disabled={sending || !targets.length}>{sending ? 'Sending…' : 'Send message'}</button></footer>
      </form>}
    </section>

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Conversation threads</p><h2>Replies</h2></div><span className="muted">{conversations.length} conversations</span></div>
      {!conversations.length ? <div className="empty"><strong>No conversations yet</strong></div> : <div className="data-list">{conversations.map(([id, thread]) => <article className="message-row" key={id}><strong>{thread[0].subject}</strong><small>{thread.length} message{thread.length === 1 ? '' : 's'} · {thread[0].conversationId.slice(0, 8)}…</small><p className="message-body">{thread[thread.length - 1].content}</p></article>)}</div>}
    </section>

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Cross-project guardrail</p><h2>Communication rules</h2></div></div>
      <form onSubmit={async (event) => { event.preventDefault(); if (ruleFrom !== ruleTo) await onSaveRule({ fromProjectId: ruleFrom, toProjectId: ruleTo, effect: ruleEffect, enabled: true }); }}>
        <div className="form-grid"><label>From project<select required value={ruleFrom} onChange={(event) => setRuleFrom(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>To project<select required value={ruleTo} onChange={(event) => setRuleTo(event.target.value)}>{projects.filter((project) => project.id !== ruleFrom).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
        <label>Effect<select value={ruleEffect} onChange={(event) => setRuleEffect(event.target.value as 'ALLOW' | 'DENY')}><option value="ALLOW">Allow messages</option><option value="DENY">Deny messages</option></select></label>
        <footer className="form-actions"><button className="button primary" disabled={projects.length < 2}>Save rule</button></footer>
      </form>
      <div className="data-list">{communicationRules.map((rule) => <div className="data-row" key={rule.id}><span>{projectById.get(rule.fromProjectId)?.name ?? shortId(rule.fromProjectId)} → {projectById.get(rule.toProjectId)?.name ?? shortId(rule.toProjectId)}</span><StatusLike value={rule.effect} /><button className="button ghost" type="button" onClick={() => void onDeleteRule(rule.id)}>Delete</button></div>)}</div>
    </section>
  </div>;
}

function StatusLike({ value }: { value: string }) { return <span className={`status status-${value.toLowerCase()}`}><span className="status-dot" />{label(value)}</span>; }
