import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type OperationExternalWait } from './api';
import type { Agent, OperationRun, OperationRunDetail, OperationalEnvironment, OperationalRunbook, OperationalService, Project, WorkspaceCleanupRecord } from './types';

const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const shortId = (value: string | null) => value ? `${value.slice(0, 8)}…` : '—';
const humanBytes = (bytes: number | null) => {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

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
  const [cleanupHistory, setCleanupHistory] = useState<WorkspaceCleanupRecord[]>([]);
  const [selectedRun, setSelectedRun] = useState<OperationRunDetail | null>(null);
  const [externalWaits, setExternalWaits] = useState<OperationExternalWait[]>([]);
  const [launchRunbook, setLaunchRunbook] = useState<OperationalRunbook | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextEnvironments, nextServices, nextRunbooks, nextRuns, nextCleanup] = await Promise.all([
        api.operationalEnvironments(), api.operationalServices(), api.operationalRunbooks(), api.operationRuns(),
        api.workspaceCleanupHistory(projectFilter === 'all' ? undefined : projectFilter)
      ]);
      setEnvironments(nextEnvironments);
      setServices(nextServices);
      setRunbooks(nextRunbooks);
      setRuns(nextRuns);
      setCleanupHistory(nextCleanup);
      setError(null);
      if (selectedRun) {
        const [detail, waits] = await Promise.all([
          api.operationRun(selectedRun.run.id), api.operationExternalWaits(selectedRun.run.id)
        ]);
        setSelectedRun(detail);
        setExternalWaits(waits);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load operational state');
    }
  }, [selectedRun?.run.id, projectFilter]);

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
  const visibleCodingAgents = agents.filter((agent) => !agent.systemManaged && agent.workspaceMode === 'ISOLATED_WORKTREE' && (projectFilter === 'all' || agent.projectId === projectFilter));
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

  async function selectRun(runId: string) {
    setBusy(true);
    try {
      const [detail, waits] = await Promise.all([api.operationRun(runId), api.operationExternalWaits(runId)]);
      setSelectedRun(detail);
      setExternalWaits(waits);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load operation evidence');
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

  async function cleanup(agent: Agent) {
    await mutate(async () => {
      const inspection = await api.workspaceCleanupInspection(agent.id);
      if (!inspection.eligible) throw new Error(`Cleanup refused: ${inspection.reason}`);
      return api.cleanupWorkspace(agent.id, 'Operator requested safe cleanup from Operations UI');
    });
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
      <div><span>Active runs</span><strong>{visibleRuns.filter((run) => ['WAITING_APPROVAL', 'QUEUED', 'RUNNING', 'WAITING_EXTERNAL'].includes(run.status)).length}</strong></div>
    </section>

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Deterministic procedures</p><h2>Runbooks</h2></div></div>
      {!visibleRunbooks.length ? <div className="empty"><strong>No runbooks registered</strong><p>Register project operational contracts before agents can request governed operations.</p></div> : <div className="data-list">
        {visibleRunbooks.map((runbook) => <div className="data-row task-detail-row" key={runbook.id}>
          <div><strong>{runbook.name}</strong><small>{projectById.get(runbook.projectId)?.name} · {runbook.key} · v{runbook.version}</small></div>
          <span>{runbook.action}</span><span>{environmentById.get(runbook.environmentId)?.displayName ?? runbook.environmentKey}</span><span>{runbook.steps.length} steps</span>
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
          <Status value={run.status} /><span>{run.policyEffect}</span><span>{run.environmentKey}</span><time>{new Date(run.createdAt).toLocaleString()}</time>
          <div className="top-actions">
            <button className="button compact ghost" disabled={busy} onClick={() => void selectRun(run.id)}>Evidence</button>
            {run.status === 'WAITING_APPROVAL' && <button className="button compact primary" disabled={busy} onClick={() => void mutate(() => api.approveOperation(run.id))}>Approve</button>}
            {run.status === 'WAITING_APPROVAL' && <button className="button compact secondary" disabled={busy} onClick={() => void mutate(() => api.declineOperation(run.id))}>Decline</button>}
          </div>
        </div>)}
      </div>}
    </section>

    {selectedRun && <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Immutable evidence</p><h2>{shortId(selectedRun.run.id)} · {selectedRun.run.action}</h2></div><button className="button ghost" onClick={() => { setSelectedRun(null); setExternalWaits([]); }}>Close</button></div>
      {externalWaits.length > 0 && <>
        <p className="eyebrow">External workflows</p>
        <div className="data-list">
          {externalWaits.map((wait) => <div className="data-row task-row" key={wait.id}>
            <div><strong>{wait.workflow}</strong><small>{wait.repository} · {wait.mode}</small></div>
            <Status value={wait.status} />
            <code title={wait.expectedHeadSha}>{shortId(wait.expectedHeadSha)}</code>
            <span>{wait.lastObservedStatus ?? 'awaiting event'}{wait.lastObservedConclusion ? ` / ${wait.lastObservedConclusion}` : ''}</span>
            {wait.externalUrl ? <a href={wait.externalUrl} target="_blank" rel="noreferrer">GitHub run {wait.externalRunId ?? ''}</a> : <span className="muted">Deadline {new Date(wait.deadline).toLocaleString()}</span>}
          </div>)}
        </div>
      </>}
      <p className="eyebrow">Runbook steps</p>
      <div className="data-list">
        {selectedRun.steps.length === 0 ? <div className="empty"><strong>No steps executed yet</strong><p>Run status is {label(selectedRun.run.status)}.</p></div> : selectedRun.steps.map((step) => <div className="data-row task-row" key={step.id}>
          <div><strong>{step.stepName}</strong><small>{step.stepType} · {step.durationMs ?? 0} ms</small></div><Status value={step.status} /><span>{step.summary ?? '—'}</span><code title={step.evidence ?? undefined}>{step.evidence ? step.evidence.slice(0, 120) : '—'}</code>
        </div>)}
      </div>
      {selectedRun.run.lastError && <div className="error-banner"><strong>Run error</strong><span>{selectedRun.run.lastError}</span></div>}
    </section>}

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Disk lifecycle</p><h2>Coding worktrees</h2></div><span className="muted">Automatic retention cleanup is fail-closed</span></div>
      {!visibleCodingAgents.length ? <div className="empty"><strong>No isolated coding worktrees</strong><p>System-managed Operational Agents use the shared project workspace.</p></div> : <div className="data-list">
        {visibleCodingAgents.map((agent) => <div className="data-row task-detail-row" key={agent.id}>
          <div><strong>{agent.name}</strong><small>{projectById.get(agent.projectId)?.name}</small></div>
          <Status value={agent.status} /><code>{agent.branch ?? '—'}</code><span>{new Date(agent.updatedAt).toLocaleString()}</span>
          <span className="muted">{agent.workspaceMode}</span>
          <button className="button compact secondary" disabled={busy} onClick={() => void cleanup(agent)}>Cleanup if safe</button>
        </div>)}
      </div>}
    </section>

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Cleanup audit</p><h2>Recent workspace cleanup</h2></div></div>
      {!cleanupHistory.length ? <div className="empty"><strong>No worktrees cleaned yet</strong><p>Merged, clean, inactive coding worktrees become eligible after the configured retention period.</p></div> : <div className="data-list">
        {cleanupHistory.slice(0, 20).map((record) => <div className="data-row task-row" key={record.id}>
          <div><strong>{record.branch ?? 'worktree'}</strong><small>{projectById.get(record.projectId)?.name}</small></div><Status value={record.outcome} /><span>{record.reason}</span><span>{humanBytes(record.freedBytes)}</span><time>{new Date(record.createdAt).toLocaleString()}</time>
        </div>)}
      </div>}
    </section>
  </div>;
}
