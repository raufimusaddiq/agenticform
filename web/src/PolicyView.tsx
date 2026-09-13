import { FormEvent, useMemo, useState } from 'react';
import type { PolicyDecision, PolicyEffect, PolicyRule, PolicyScopeType, Project, Agent, Task } from './types';
import type { PolicyRuleInput } from './api';
import './policy.css';

const effects: PolicyEffect[] = ['ALLOW', 'REQUIRE_HUMAN', 'DENY'];
const scopes: PolicyScopeType[] = ['GLOBAL', 'PROJECT', 'AGENT', 'TASK'];
const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const shortId = (value: string | null) => value ? `${value.slice(0, 8)}...` : '-';

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

  const projectById = useMemo(() => new Map(projects.map((item) => [item.id, item.name])), [projects]);
  const agentById = useMemo(() => new Map(agents.map((item) => [item.id, item.name])), [agents]);
  const taskById = useMemo(() => new Map(tasks.map((item) => [item.id, item.title])), [tasks]);

  function startEdit(rule: PolicyRule) {
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

  return <div className="page-stack policy-page">
    <section className="panel">
      <div className="section-header">
        <div><p className="eyebrow">Deterministic governance</p><h2>Policy rules</h2></div>
        <span className="muted">TASK / AGENT / PROJECT / GLOBAL</span>
      </div>
      <p className="policy-note">Within the same scope, exact action beats <code>*</code>, then exact environment beats <code>*</code>. The global <code>* / *</code> fallback cannot be deleted or disabled.</p>
      <div className="policy-table">
        {rules.map((rule) => <div className="policy-row" key={rule.id}>
          <div><strong>{rule.action}</strong><small>{rule.environment}</small></div>
          <div><span className="policy-scope">{label(rule.scopeType)}</span><small>{scopeName(rule)}</small></div>
          <span className={`policy-effect policy-effect-${rule.effect.toLowerCase()}`}>{label(rule.effect)}</span>
          <p>{rule.description}</p>
          <span className={rule.enabled ? 'policy-enabled' : 'muted'}>{rule.enabled ? 'Enabled' : 'Disabled'}</span>
          <div className="policy-actions"><button className="button compact secondary" onClick={() => startEdit(rule)}>Edit</button><button className="button compact ghost" disabled={rule.scopeType === 'GLOBAL' && rule.action === '*' && rule.environment === '*'} onClick={() => void onDelete(rule.id)}>Delete</button></div>
        </div>)}
      </div>
    </section>

    <div className="policy-grid">
      <section className="panel">
        <div className="section-header"><div><p className="eyebrow">Configuration</p><h2>{editing ? 'Edit rule' : 'New rule'}</h2></div>{editing && <button className="button ghost" onClick={reset}>Cancel edit</button>}</div>
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
      </section>

      <section className="panel">
        <div className="section-header"><div><p className="eyebrow">Dry run</p><h2>Decision simulator</h2></div></div>
        <form onSubmit={(event) => void simulate(event)}>
          <div className="form-grid"><label>Action<input required value={simAction} onChange={(event) => setSimAction(event.target.value)} /></label><label>Environment<input value={simEnvironment} onChange={(event) => setSimEnvironment(event.target.value)} /></label></div>
          <label>Project <span className="optional">optional</span><select value={simProjectId} onChange={(event) => setSimProjectId(event.target.value)}><option value="">None</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Agent <span className="optional">optional</span><select value={simAgentId} onChange={(event) => setSimAgentId(event.target.value)}><option value="">None</option>{agents.filter((item) => !simProjectId || item.projectId === simProjectId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Task <span className="optional">optional</span><select value={simTaskId} onChange={(event) => setSimTaskId(event.target.value)}><option value="">None</option>{tasks.filter((item) => !simProjectId || item.projectId === simProjectId).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <footer className="form-actions"><button className="button secondary">Evaluate</button></footer>
        </form>
        {simError && <div className="inline-error">{simError}</div>}
        {decision && <div className="policy-decision"><span className={`policy-effect policy-effect-${decision.effect.toLowerCase()}`}>{label(decision.effect)}</span><strong>{decision.action} / {decision.environment}</strong><p>{decision.description}</p><code>{label(decision.matchedScopeType)} / {shortId(decision.matchedRuleId)}</code></div>}
      </section>
    </div>
  </div>;
}
