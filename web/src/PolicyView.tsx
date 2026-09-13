import { FormEvent, useMemo, useState } from 'react';
import type { PolicyDecision, PolicyEffect, PolicyRule, PolicyScopeType, Project, Agent, Task } from './types';
import type { PolicyRuleInput } from './api';
import './policy.css';
import { Status, label, shortId } from './ui';

const effects: PolicyEffect[] = ['ALLOW', 'REQUIRE_HUMAN', 'DENY'];
const scopes: PolicyScopeType[] = ['GLOBAL', 'PROJECT', 'AGENT', 'TASK'];

export function PolicyView({ rules, projects, agents, tasks, onCreate, onUpdate, onDelete, onEvaluate }: {
  rules: PolicyRule[];
  projects: Project[];
  agents: Agent[];
  tasks: Task[];
  onCreate: (input: PolicyRuleInput) => Promise<void>;
  onUpdate: (id: string, input: PolicyRuleInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEvaluate: (input: { projectId?: string | null; agentId?: string | null; taskId?: string | null; action: string; environment?: string }) => Promise<PolicyDecision>;
}) {
  const [editing, setEditing] = useState<PolicyRule | null>(null);
  const [scopeType, setScopeType] = useState<PolicyScopeType>('GLOBAL');
  const [scopeId, setScopeId] = useState('');
  const [action, setAction] = useState('');
  const [environment, setEnvironment] = useState('*');
  const [effect, setEffect] = useState<PolicyEffect>('REQUIRE_HUMAN');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [simAction, setSimAction] = useState('PRODUCTION_DEPLOY');
  const [simEnvironment, setSimEnvironment] = useState('production');
  const [simProjectId, setSimProjectId] = useState('');
  const [simAgentId, setSimAgentId] = useState('');
  const [simTaskId, setSimTaskId] = useState('');
  const [decision, setDecision] = useState<PolicyDecision | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(rules[0]?.id ?? null);
  const [editorOpen, setEditorOpen] = useState(false);

  const projectById = useMemo(() => new Map(projects.map((item) => [item.id, item.name])), [projects]);
  const agentById = useMemo(() => new Map(agents.map((item) => [item.id, item.name])), [agents]);
  const taskById = useMemo(() => new Map(tasks.map((item) => [item.id, item.title])), [tasks]);

  function startEdit(rule: PolicyRule) {
    setEditorOpen(true);
    setEditing(rule);
    setScopeType(rule.scopeType);
    setScopeId(rule.scopeId ?? '');
    setAction(rule.action);
    setEnvironment(rule.environment);
    setEffect(rule.effect);
    setDescription(rule.description);
    setEnabled(rule.enabled);
  }

  function reset() {
    setEditing(null);
    setScopeType('GLOBAL');
    setScopeId('');
    setAction('');
    setEnvironment('*');
    setEffect('REQUIRE_HUMAN');
    setDescription('');
    setEnabled(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const input: PolicyRuleInput = {
      scopeType,
      scopeId: scopeType === 'GLOBAL' ? null : scopeId,
      action,
      environment,
      effect,
      description,
      enabled
    };
    if (editing) await onUpdate(editing.id, input); else await onCreate(input);
    reset();
  }

  async function simulate(event: FormEvent) {
    event.preventDefault();
    try {
      setSimError(null);
      setDecision(await onEvaluate({
        projectId: simProjectId || null,
        agentId: simAgentId || null,
        taskId: simTaskId || null,
        action: simAction,
        environment: simEnvironment
      }));
    } catch (error) {
      setDecision(null);
      setSimError(error instanceof Error ? error.message : 'Unable to evaluate policy');
    }
  }

  function scopeName(rule: PolicyRule) {
    if (rule.scopeType === 'GLOBAL') return 'Global';
    if (rule.scopeType === 'PROJECT') return projectById.get(rule.scopeId ?? '') ?? shortId(rule.scopeId);
    if (rule.scopeType === 'AGENT') return agentById.get(rule.scopeId ?? '') ?? shortId(rule.scopeId);
    return taskById.get(rule.scopeId ?? '') ?? shortId(rule.scopeId);
  }

  function scopeOptions() {
    if (scopeType === 'PROJECT') return projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>);
    if (scopeType === 'AGENT') return agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>);
    if (scopeType === 'TASK') return tasks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>);
    return null;
  }

  const selected = rules.find((rule) => rule.id === selectedId) ?? rules[0];
  return <div className="page-stack policy-page">
    <section className="panel">
      <div className="section-header"><h2>Policy</h2><div className="top-actions"><button className="button secondary" onClick={() => { reset(); setEditorOpen(true); }}>Create rule</button><button className="button secondary" onClick={() => document.getElementById('policy-evaluate')?.scrollIntoView({ behavior: 'smooth' })}>Evaluate</button></div></div>
      <p className="policy-note">Exact action and environment match before wildcard rules. The global fallback cannot be deleted or disabled.</p>
      {!rules.length ? <div className="empty"><strong>No policy rules</strong><p>Create a rule to govern agent actions.</p></div> : <div className="split-workbench"><div className="workbench-table policy-table"><div className="table-head"><span>Scope</span><span>Action</span><span>Environment</span><span>Effect</span><span>Enabled</span></div>{rules.map((rule) => <button className={`table-row${selected?.id === rule.id ? ' selected' : ''}`} key={rule.id} onClick={() => setSelectedId(rule.id)}><span>{scopeName(rule)}</span><code>{rule.action}</code><code>{rule.environment}</code><Status value={rule.effect}>{label(rule.effect)}</Status><span className={rule.enabled ? 'policy-enabled' : 'muted'}>{rule.enabled ? 'Yes' : 'No'}</span></button>)}</div><aside className="inspector">{selected ? <><h3>Selected rule</h3><dl><dt>Scope</dt><dd>{label(selected.scopeType)}</dd><dt>Target</dt><dd>{scopeName(selected)}</dd><dt>Action</dt><dd><code>{selected.action}</code></dd><dt>Environment</dt><dd><code>{selected.environment}</code></dd><dt>Effect</dt><dd><Status value={selected.effect}>{label(selected.effect)}</Status></dd><dt>Enabled</dt><dd>{selected.enabled ? 'Yes' : 'No'}</dd><dt>Description</dt><dd>{selected.description || '-'}</dd><dt>Precedence</dt><dd>Scope, action, environment</dd></dl><div className="top-actions"><button className="button compact secondary" onClick={() => startEdit(selected)}>Edit</button><button className="button compact danger" disabled={selected.scopeType === 'GLOBAL' && selected.action === '*' && selected.environment === '*'} onClick={() => void onDelete(selected.id)}>Delete</button></div></> : <p className="muted">Select a rule.</p>}</aside></div>}
    </section>

    <details className="secondary-section" open={editorOpen} onToggle={(event) => setEditorOpen(event.currentTarget.open)}>
      <summary>{editing ? 'Edit rule' : 'Create rule'}</summary>
      <form onSubmit={(event) => void save(event)}>
          <div className="form-grid">
            <label>Scope<select value={scopeType} onChange={(event) => { setScopeType(event.target.value as PolicyScopeType); setScopeId(''); }}>{scopes.map((scope) => <option key={scope} value={scope}>{label(scope)}</option>)}</select></label>
            {scopeType !== 'GLOBAL' && <label>Scope target<select required value={scopeId} onChange={(event) => setScopeId(event.target.value)}><option value="">Select target</option>{scopeOptions()}</select></label>}
          </div>
          <div className="form-grid"><label>Action<input required value={action} onChange={(event) => setAction(event.target.value)} placeholder="MERGE_MAIN or *" /></label><label>Environment<input value={environment} onChange={(event) => setEnvironment(event.target.value)} placeholder="production or *" /></label></div>
          <label>Effect<select value={effect} onChange={(event) => setEffect(event.target.value as PolicyEffect)}>{effects.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
          <label>Description<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Why this rule exists and what it protects." /></label>
          <label className="policy-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label>
          <footer className="form-actions"><button className="button primary">{editing ? 'Save rule' : 'Create rule'}</button></footer>
        </form>
    </details>

    <details className="secondary-section" id="policy-evaluate">
      <summary>Evaluate policy</summary>
        <form onSubmit={(event) => void simulate(event)}>
          <div className="form-grid"><label>Action<input required value={simAction} onChange={(event) => setSimAction(event.target.value)} /></label><label>Environment<input value={simEnvironment} onChange={(event) => setSimEnvironment(event.target.value)} /></label></div>
          <label>Project <span className="optional">optional</span><select value={simProjectId} onChange={(event) => setSimProjectId(event.target.value)}><option value="">None</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Agent <span className="optional">optional</span><select value={simAgentId} onChange={(event) => setSimAgentId(event.target.value)}><option value="">None</option>{agents.filter((item) => !simProjectId || item.projectId === simProjectId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Task <span className="optional">optional</span><select value={simTaskId} onChange={(event) => setSimTaskId(event.target.value)}><option value="">None</option>{tasks.filter((item) => !simProjectId || item.projectId === simProjectId).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <footer className="form-actions"><button className="button secondary">Evaluate</button></footer>
        </form>
        {simError && <div className="inline-error">{simError}</div>}
        {decision && <div className="policy-decision"><Status value={decision.effect}>{label(decision.effect)}</Status><strong>{decision.action} / {decision.environment}</strong><p>{decision.description}</p><code>{label(decision.matchedScopeType)} / {shortId(decision.matchedRuleId)}</code></div>}
    </details>
  </div>;
}
