import { FormEvent, useMemo, useState } from 'react';
import type { Agent, AgentMessage, AgentMessageType, CommunicationRule, Project } from './types';
import { Status, label, shortId } from './ui';
import './messages.css';

const messageTypes: AgentMessageType[] = [
  'QUESTION', 'ANSWER', 'REQUEST', 'RESULT', 'HANDOFF',
  'REVIEW_REQUEST', 'REVIEW_RESULT', 'INFORMATION', 'BLOCKER'
];


export function MessagesView({ messages, agents, projects, communicationRules, onSend, onSaveRule, onDeleteRule }: {
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
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const conversations = useMemo(() => {
    const grouped = new Map<string, AgentMessage[]>();
    messages.forEach((message) => grouped.set(message.conversationId, [...(grouped.get(message.conversationId) ?? []), message]));
    return [...grouped.entries()].sort((a, b) => Date.parse(b[1][b[1].length - 1].createdAt) - Date.parse(a[1][a[1].length - 1].createdAt));
  }, [messages]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const activeConversation = conversations.find(([id]) => id === selectedConversationId)?.[1] ?? conversations[0]?.[1] ?? [];

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

  return <div className="page-stack">
    <section className="communication-workspace">
      <aside className="conversation-index">
        <div className="section-header"><h2>Conversations</h2><span className="muted">{messages.length}</span></div>
        {!conversations.length ? <div className="empty"><strong>No conversations</strong><p>Messages exchanged through Codex tools will appear here.</p></div> : <div className="conversation-list">{conversations.map(([id, thread]) => {
          const last = thread[thread.length - 1];
          const from = agentById.get(last.fromAgentId)?.name ?? shortId(last.fromAgentId);
          const active = (selectedConversationId ?? conversations[0][0]) === id;
          return <button className={`conversation-item${active ? ' active' : ''}`} type="button" key={id} onClick={() => setSelectedConversationId(id)}><strong>{thread[0].subject}</strong><span>{from} / {thread.length} message{thread.length === 1 ? '' : 's'}</span><small>{relativeTime(last.updatedAt)}</small></button>;
        })}</div>}
      </aside>
      <section className="conversation-thread" aria-label="Active conversation">
        <div className="section-header"><h2>{activeConversation[0]?.subject ?? 'Select a conversation'}</h2>{activeConversation[0] && <code>{shortId(activeConversation[0].conversationId)}</code>}</div>
        {!activeConversation.length ? <div className="empty"><strong>Nothing selected</strong><p>Choose a conversation to inspect its delivery state and reply chain.</p></div> : <div className="message-timeline">{activeConversation.map((message) => {
          const from = agentById.get(message.fromAgentId);
          const to = message.toAgentId ? agentById.get(message.toAgentId) : undefined;
          const targetLabel = to?.name ?? (message.toAgentId ? shortId(message.toAgentId) : label(message.audienceType));
          return <article className="message-row" key={message.id}>
            <div className="message-meta"><div><strong>{from?.name ?? shortId(message.fromAgentId)}</strong><small>{projectById.get(message.projectId)?.name ?? 'Unknown project'} / {new Date(message.createdAt).toLocaleString()}</small></div><span className={`message-type message-type-${message.type.toLowerCase()}`}>{label(message.type)}</span><Status value={message.status} /></div>
            <p className="message-route"><span>to</span><strong>{targetLabel}</strong><span>hop {message.hopCount}/6</span></p>
            <p className="message-body">{message.content}</p>
            <button className="button ghost" type="button" onClick={() => { setReplyTo(message); setFromAgentId(message.toAgentId ?? source?.id ?? ''); setToAgentId(message.fromAgentId); }}>Reply</button>
            <div className="message-machine"><code>message {shortId(message.id)}</code><code>queue {shortId(message.queuedSubmissionId)}</code><code>turn {shortId(message.turnId)}</code></div>
            {message.lastError && <p className="inline-error">{message.lastError}</p>}
          </article>;
        })}</div>}
      </section>
    </section>

    <section className="compose-panel">
      <div className="section-header"><h2>Send message</h2></div>
      {!agents.length ? <div className="empty"><strong>No agents available</strong><p>Spawn agents before using the mailbox.</p></div> : <form onSubmit={submit}>
        <div className="form-grid">
          <label>From agent<select value={source?.id ?? ''} onChange={(event) => { setFromAgentId(event.target.value); setToAgentId(''); }}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select></label>
          <label>To agent<select required value={toAgentId || targets[0]?.id || ''} onChange={(event) => setToAgentId(event.target.value)} disabled={!targets.length}>
            {targets.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} / {label(agent.status)}</option>)}
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

    <details className="secondary-section rules-panel">
      <summary>Communication rules <span className="muted">{communicationRules.length}</span></summary>
      <form onSubmit={async (event) => { event.preventDefault(); if (ruleFrom !== ruleTo) await onSaveRule({ fromProjectId: ruleFrom, toProjectId: ruleTo, effect: ruleEffect, enabled: true }); }}>
        <div className="form-grid"><label>From project<select required value={ruleFrom} onChange={(event) => setRuleFrom(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>To project<select required value={ruleTo} onChange={(event) => setRuleTo(event.target.value)}>{projects.filter((project) => project.id !== ruleFrom).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
        <label>Effect<select value={ruleEffect} onChange={(event) => setRuleEffect(event.target.value as 'ALLOW' | 'DENY')}><option value="ALLOW">Allow messages</option><option value="DENY">Deny messages</option></select></label>
        <footer className="form-actions"><button className="button primary" disabled={projects.length < 2}>Save rule</button></footer>
      </form>
      <div className="data-list">{communicationRules.map((rule) => <div className="data-row" key={rule.id}><span>{projectById.get(rule.fromProjectId)?.name ?? shortId(rule.fromProjectId)} to {projectById.get(rule.toProjectId)?.name ?? shortId(rule.toProjectId)}</span><StatusLike value={rule.effect} /><button className="button ghost" type="button" onClick={() => void onDeleteRule(rule.id)}>Delete</button></div>)}</div>
    </details>
  </div>;
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function StatusLike({ value }: { value: string }) { return <Status value={value} />; }
