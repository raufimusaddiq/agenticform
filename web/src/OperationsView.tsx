import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { Agent, OperationRun, OperationRunDetail, OperationalEnvironment, OperationalRunbook, OperationalService, Project } from './types';

const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const shortId = (value: string | null) => value ? `${value.slice(0, 8)}…` : '—';

function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}><span className="status-dot" />{label(value)}</span>;
}

function inferParameters(runbook: OperationalRunbook) {
  const names = new Set<string>();
  const text = JSON.stringify(runbook.steps);
  const matcher = /\$\{param:([A-Za-z0-9_.-]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) names.add(match[1]);
  return [...names].sort();
}

export function OperationsView({ projects, agents, projectFilter }: {
  projects: Project[];
  agents: Agent[];
  projectFilter: string;
}) {
  const [environments, setEnvironments] = useState<OperationalEnvironment[]>([]);
  const [services, setServices] = useState<OperationalService[]>([]);
  const [runbooks, setRunbooks] = useState<OperationalRunbook[]>([]);
  const [runs, setRuns] = useState<OperationRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<OperationRunDetail | null>(null);
  const [launchRunbook, setLaunchRunbook] = useState<OperationalRunbook | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextEnvironments, nextServices, nextRunbooks, nextRuns] = await Promise.all([
        api.operationalEnvironments(), api.operationalServices(), api.operationalRunbooks(), api.operationRuns()
      ]);
      setEnvironments(nextEnvironments);
      setServices(nextServices);
      setRunbooks(nextRunbooks);
      setRuns(nextRuns);
      setError(null);
      if (selectedRun) {
        const detail = await api.operationRun(selectedRun.run.id);
        setSelectedRun(detail);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load operational state');
    }
  }, [selectedRun?.run.id]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const scoped = <T extends { projectId: string }>(rows: T[]) => projectFilter === 'all' ? rows : rows.filter((row) => row.projectId === projectFilter);
  const visibleEnvironments = scoped(environments);
  const visibleServices = scoped(services);
  const visibleRunbooks = scoped(runbooks);
  const visibleRuns = scoped(runs);
  const visibleProjects = projectFilter === 'all' ? projects : projects.filter((project) => project.id === projectFilter);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const environmentById = useMemo(() => new Map(environments.map((environment) => [environment.id, environment])), [environments]);
  const runbookById = useMemo(() => new Map(runbooks.map((runbook) => [runbook.id, runbook])), [runbooks]);

  async function mutate(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      setError(null);
      await work();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Operational action failed');
    } finally {
      setBusy(false);
    }
  }

  function beginRun(runbook: OperationalRunbook) {
    const names = inferParameters(runbook);
    setParameters(Object.fromEntries(names.map((name) => [name, ''])));
    setLaunchRunbook(runbook);
  }

  async function submitRun(event: FormEvent) {
    event.preventDefault();
    if (!launchRunbook) return;
    const clean = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, value.trim()]));
    await mutate(() => api.startOperation(launchRunbook.id, { requestedBy: 'operator', parameters: clean }));
    setLaunchRunbook(null);
    setParameters({});
  }

  async function ensureOps(projectId: string) {
    await mutate(() => api.ensureOperationalAgent(projectId));
  }

  return <div className="page-stack">
    {error && <div className="error-banner"><strong>Operational action required</strong><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Agentic operations</p><h2>Operational agents</h2></div></div>
      <div className="data-list">
        {visibleProjects.map((project) => {
          const ops = agents.find((agent) => agent.projectId === project.id && agent.role === 'OPERATIONAL');
          return <div className="data-row project-row" key={project.id}>
            <div><strong>{project.name}</strong><small>Default operational coordinator</small></div>
            {ops ? <Status value={ops.status} /> : <span className="muted">Not provisioned</span>}
            <span>{ops ? 'System managed' : 'Provision on demand'}</span>
            <code>{ops ? shortId(ops.codexThreadId) : '—'}</code>
            {!ops && <button className="button compact secondary" disabled={busy} onClick={() => void ensureOps(project.id)}>Provision</button>}
          </div>;
        })}
      </div>
    </section>

    <section className="metrics-strip">
      <div><span>Environments</span><strong>{visibleEnvironments.length}</strong></div>
      <div><span>Services</span><strong>{visibleServices.length}</strong></div>
      <div><span>Runbooks</span><strong>{visibleRunbooks.filter((runbook) => runbook.enabled).length}</strong></div>
      <div><span>Active runs</span><strong>{visibleRuns.filter((run) => ['WAITING_APPROVAL', 'QUEUED', 'RUNNING'].includes(run.status)).length}</strong></div>
    </section>

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Deterministic procedures</p><h2>Runbooks</h2></div></div>
      {!visibleRunbooks.length ? <div className="empty"><strong>No runbooks registered</strong><p>Register project operational contracts before agents can request governed operations.</p></div> : <div className="data-list">
        {visibleRunbooks.map((runbook) => <div className="data-row task-detail-row" key={runbook.id}>
          <div><strong>{runbook.name}</strong><small>{projectById.get(runbook.projectId)?.name} · {runbook.key} · v{runbook.version}</small></div>
          <span>{runbook.action}</span>
          <span>{environmentById.get(runbook.environmentId)?.displayName ?? runbook.environmentKey}</span>
          <span>{runbook.steps.length} steps</span>
          <Status value={runbook.enabled ? 'IDLE' : 'STOPPED'} />
          <button className="button compact secondary" disabled={!runbook.enabled || busy} onClick={() => beginRun(runbook)}>Run</button>
        </div>)}
      </div>}
    </section>

    {launchRunbook && <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Start operation</p><h2>{launchRunbook.name}</h2></div><button className="button ghost" onClick={() => setLaunchRunbook(null)}>Cancel</button></div>
      <p className="form-note">Action <code>{launchRunbook.action}</code> in <code>{launchRunbook.environmentKey}</code> is evaluated by deterministic policy before execution.</p>
      <form onSubmit={submitRun}>
        {Object.keys(parameters).length === 0 ? <p className="muted">This runbook has no runtime parameters.</p> : Object.keys(parameters).map((name) => <label key={name}>{name}<input required className="mono" value={parameters[name]} onChange={(event) => setParameters((current) => ({ ...current, [name]: event.target.value }))} /></label>)}
        <footer className="form-actions"><button className="button primary" disabled={busy}>Request run</button></footer>
      </form>
    </section>}

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Execution history</p><h2>Operation runs</h2></div><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>
      {!visibleRuns.length ? <div className="empty"><strong>No operation runs</strong><p>Operational Agent and operator requests will appear here with policy and execution evidence.</p></div> : <div className="data-list">
        {visibleRuns.map((run) => <div className="data-row task-detail-row" key={run.id}>
          <div><strong>{runbookById.get(run.runbookId)?.name ?? run.action}</strong><small>{projectById.get(run.projectId)?.name} · {shortId(run.id)}</small></div>
          <Status value={run.status} />
          <span>{run.policyEffect}</span>
          <span>{run.environmentKey}</span>
          <time>{new Date(run.createdAt).toLocaleString()}</time>
          <div className="top-actions">
            <button className="button compact ghost" disabled={busy} onClick={() => void mutate(async () => setSelectedRun(await api.operationRun(run.id)))}>Evidence</button>
            {run.status === 'WAITING_APPROVAL' && <button className="button compact primary" disabled={busy} onClick={() => void mutate(() => api.approveOperation(run.id))}>Approve</button>}
            {run.status === 'WAITING_APPROVAL' && <button className="button compact secondary" disabled={busy} onClick={() => void mutate(() => api.declineOperation(run.id))}>Decline</button>}
          </div>
        </div>)}
      </div>}
    </section>

    {selectedRun && <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Immutable evidence</p><h2>{shortId(selectedRun.run.id)} · {selectedRun.run.action}</h2></div><button className="button ghost" onClick={() => setSelectedRun(null)}>Close</button></div>
      <div className="data-list">
        {selectedRun.steps.length === 0 ? <div className="empty"><strong>No steps executed yet</strong><p>Run status is {label(selectedRun.run.status)}.</p></div> : selectedRun.steps.map((step) => <div className="data-row task-row" key={step.id}>
          <div><strong>{step.stepName}</strong><small>{step.stepType} · {step.durationMs ?? 0} ms</small></div>
          <Status value={step.status} />
          <span>{step.summary ?? '—'}</span>
          <code title={step.evidence ?? undefined}>{step.evidence ? step.evidence.slice(0, 120) : '—'}</code>
        </div>)}
      </div>
      {selectedRun.run.lastError && <div className="error-banner"><strong>Run error</strong><span>{selectedRun.run.lastError}</span></div>}
    </section>}
  </div>;
}
