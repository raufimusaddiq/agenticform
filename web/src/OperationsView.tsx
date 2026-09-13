import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type OperationExternalWait } from './api';
import {
  operationalIntelligenceApi,
  type OperationalIncident,
  type OperationalIncidentDetail,
  type OperationalIncidentStatus,
  type OperationalSignal
} from './operationalIntelligence';
import type { Agent, OperationRun, OperationRunDetail, OperationalEnvironment, OperationalRunbook, OperationalService, Project, WorkspaceCleanupRecord } from './types';
import { Status, label, shortId } from './ui';

const humanBytes = (bytes: number | null) => {
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

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
  const [, setServices] = useState<OperationalService[]>([]);
  const [runbooks, setRunbooks] = useState<OperationalRunbook[]>([]);
  const [runs, setRuns] = useState<OperationRun[]>([]);
  const [incidents, setIncidents] = useState<OperationalIncident[]>([]);
  const [signals, setSignals] = useState<OperationalSignal[]>([]);
  const [cleanupHistory, setCleanupHistory] = useState<WorkspaceCleanupRecord[]>([]);
  const [selectedRun, setSelectedRun] = useState<OperationRunDetail | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<OperationalIncidentDetail | null>(null);
  const [externalWaits, setExternalWaits] = useState<OperationExternalWait[]>([]);
  const [launchRunbook, setLaunchRunbook] = useState<OperationalRunbook | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [incidentPrompt, setIncidentPrompt] = useState<{ incident: OperationalIncident; status: OperationalIncidentStatus; summary: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const intelligenceProject = projectFilter === 'all' ? undefined : projectFilter;
      const [nextEnvironments, nextServices, nextRunbooks, nextRuns, nextIncidents, nextSignals, nextCleanup] = await Promise.all([
        api.operationalEnvironments(), api.operationalServices(), api.operationalRunbooks(), api.operationRuns(),
        operationalIntelligenceApi.incidents(intelligenceProject), operationalIntelligenceApi.signals(intelligenceProject),
        api.workspaceCleanupHistory(intelligenceProject)
      ]);
      setEnvironments(nextEnvironments);
      setServices(nextServices);
      setRunbooks(nextRunbooks);
      setRuns(nextRuns);
      setIncidents(nextIncidents);
      setSignals(nextSignals);
      setCleanupHistory(nextCleanup);
      setError(null);
      if (selectedRun) {
        const [detail, waits] = await Promise.all([
          api.operationRun(selectedRun.run.id), api.operationExternalWaits(selectedRun.run.id)
        ]);
        setSelectedRun(detail);
        setExternalWaits(waits);
      }
      if (selectedIncident) setSelectedIncident(await operationalIntelligenceApi.incident(selectedIncident.incident.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load operational state');
    }
  }, [selectedRun?.run.id, selectedIncident?.incident.id, projectFilter]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const scoped = <T extends { projectId: string }>(rows: T[]) => projectFilter === 'all' ? rows : rows.filter((row) => row.projectId === projectFilter);
  const visibleEnvironments = scoped(environments);
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
      setSelectedIncident(null);
      setExternalWaits(waits);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load operation evidence');
    } finally {
      setBusy(false);
    }
  }

  async function selectIncident(incidentId: string) {
    setBusy(true);
    try {
      setSelectedIncident(await operationalIntelligenceApi.incident(incidentId));
      setSelectedRun(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load incident evidence');
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

  async function transitionIncident(incident: OperationalIncident, status: OperationalIncidentStatus) {
    let summary: string | undefined;
    if (status === 'RESOLVED' || status === 'SUPPRESSED') {
      setIncidentPrompt({ incident, status, summary: '' });
      return;
    } else {
      summary = status === 'INVESTIGATING' ? 'Operator acknowledged incident for investigation' : 'Mitigation is in progress';
    }
    await mutate(() => operationalIntelligenceApi.transitionIncident(incident.id, status, summary));
  }

  return <div className="page-stack operations-page">
    {incidentPrompt && <div className="confirm-backdrop" role="presentation" onMouseDown={() => setIncidentPrompt(null)}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="incident-prompt-title" onMouseDown={(event) => event.stopPropagation()}><h3 id="incident-prompt-title">{incidentPrompt.status === 'RESOLVED' ? 'Resolution summary' : 'Suppression reason'}</h3><p className="muted">Record why this incident changed state.</p><textarea autoFocus required rows={4} value={incidentPrompt.summary} onChange={(event) => setIncidentPrompt({ ...incidentPrompt, summary: event.target.value })} /><div className="form-actions"><button className="button ghost" onClick={() => setIncidentPrompt(null)}>Cancel</button><button className="button primary" disabled={!incidentPrompt.summary.trim() || busy} onClick={() => { const item = incidentPrompt; setIncidentPrompt(null); void mutate(() => operationalIntelligenceApi.transitionIncident(item.incident.id, item.status, item.summary.trim())); }}>Confirm</button></div></section></div>}
    {error && <div className="error-banner"><strong>Operational action required</strong><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}

    <details className="secondary-section operations-agents">
      <summary>Operational agents</summary>
      <div className="data-list">
        {visibleProjects.map((project) => {
          const ops = agents.find((agent) => agent.projectId === project.id && agent.role === 'OPERATIONAL');
          return <div className="data-row project-row" key={project.id}>
            <div><strong>{project.name}</strong><small>Default operational coordinator</small></div>
            {ops ? <Status value={ops.status} /> : <span className="muted">Not provisioned</span>}
            <span>{ops ? 'System managed' : 'Provision on demand'}</span>
            <code>{ops ? shortId(ops.runtimeSessionId) : '-'}</code>
            {!ops && <button className="button compact secondary" disabled={busy} onClick={() => void ensureOps(project.id)}>Provision</button>}
          </div>;
        })}
      </div>
    </details>

    <section className="workbench-section operations-incidents">
      <div className="section-header"><div><h2>Open incidents</h2></div><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>
      {!incidents.length ? <div className="empty"><strong>No incidents</strong><p>Deterministic health, node, workflow, and operation signals will open incidents when configured thresholds are met.</p></div> : <div className="data-list">
        {incidents.slice(0, 30).map((incident) => <div className="data-row task-detail-row" key={incident.id}>
          <div><strong>{incident.title}</strong><small>{projectById.get(incident.projectId)?.name} / {incident.incidentType}</small></div>
          <Status value={incident.severity} /><Status value={incident.status} /><span>Wake: {label(incident.wakeStatus)}</span>
          <span title={incident.summary}>{incident.summary.slice(0, 100)}</span>
          <button className="button compact ghost" disabled={busy} onClick={() => void selectIncident(incident.id)}>Evidence</button>
        </div>)}
      </div>}
    </section>

    {selectedIncident && <aside className="inspector operation-inspector">
      <div className="section-header"><div><h2>Selected incident: {selectedIncident.incident.title}</h2></div><button className="button ghost" onClick={() => setSelectedIncident(null)}>Close</button></div>
      <dl className="operation-facts"><dt>Severity</dt><dd>{label(selectedIncident.incident.severity)}</dd><dt>Status</dt><dd>{label(selectedIncident.incident.status)}</dd><dt>Wake</dt><dd>{label(selectedIncident.incident.wakeStatus)}</dd><dt>Signals</dt><dd>{selectedIncident.signals.length}</dd></dl>
      <p>{selectedIncident.incident.summary}</p>
      {selectedIncident.incident.suspectedChange && <p className="form-note">Suspected change <code>{selectedIncident.incident.suspectedChange}</code></p>}
      {selectedIncident.incident.lastWakeError && <div className="error-banner"><strong>Agent wake failed</strong><span>{selectedIncident.incident.lastWakeError}</span></div>}
      <div className="top-actions">
        {selectedIncident.incident.status === 'OPEN' && <button className="button compact secondary" disabled={busy} onClick={() => void transitionIncident(selectedIncident.incident, 'INVESTIGATING')}>Investigate</button>}
        {['OPEN', 'INVESTIGATING'].includes(selectedIncident.incident.status) && <button className="button compact secondary" disabled={busy} onClick={() => void transitionIncident(selectedIncident.incident, 'MITIGATING')}>Mark mitigating</button>}
        {!['RESOLVED', 'SUPPRESSED'].includes(selectedIncident.incident.status) && <button className="button compact primary" disabled={busy} onClick={() => void transitionIncident(selectedIncident.incident, 'RESOLVED')}>Resolve</button>}
        {!['RESOLVED', 'SUPPRESSED'].includes(selectedIncident.incident.status) && <button className="button compact ghost" disabled={busy} onClick={() => void transitionIncident(selectedIncident.incident, 'SUPPRESSED')}>Suppress</button>}
        {selectedIncident.incident.wakeStatus === 'FAILED' && <button className="button compact secondary" disabled={busy} onClick={() => void mutate(() => operationalIntelligenceApi.retryWake(selectedIncident.incident.id))}>Retry agent wake</button>}
      </div>
      <h3>Correlated signals</h3>
      <div className="data-list">
        {selectedIncident.signals.map((signal) => <div className="data-row task-row" key={signal.id}>
          <div><strong>{label(signal.signalType)}</strong><small>{signal.source} / {signal.occurrenceCount} occurrence{signal.occurrenceCount === 1 ? '' : 's'}</small></div>
          <Status value={signal.severity} /><Status value={signal.status} /><span>{new Date(signal.lastSeenAt).toLocaleString()}</span><code title={signal.payloadJson}>{signal.payloadJson.slice(0, 120)}</code>
        </div>)}
      </div>
    </aside>}

    <details className="secondary-section operations-signals">
      <summary>Operational signals</summary>
      {!signals.length ? <div className="empty"><strong>No operational signals</strong><p>Registered monitors and operation events will appear here.</p></div> : <div className="data-list">
        {signals.slice(0, 20).map((signal) => <div className="data-row task-row" key={signal.id}>
          <div><strong>{label(signal.signalType)}</strong><small>{projectById.get(signal.projectId)?.name} / {signal.source}</small></div>
          <Status value={signal.severity} /><Status value={signal.status} /><span>{signal.occurrenceCount}×</span><time>{new Date(signal.lastSeenAt).toLocaleString()}</time>
        </div>)}
      </div>}
    </details>

    <details className="secondary-section operations-runbooks">
      <summary>Runbooks</summary>
      {!visibleRunbooks.length ? <div className="empty"><strong>No runbooks registered</strong><p>Register project operational contracts before agents can request governed operations.</p></div> : <div className="data-list">
        {visibleRunbooks.map((runbook) => <div className="data-row task-detail-row" key={runbook.id}>
          <div><strong>{runbook.name}</strong><small>{projectById.get(runbook.projectId)?.name} / {runbook.key} / v{runbook.version}</small></div>
          <span>{runbook.action}</span><span>{environmentById.get(runbook.environmentId)?.displayName ?? runbook.environmentKey}</span><span>{runbook.steps.length} steps</span>
          <Status value={runbook.enabled ? 'IDLE' : 'STOPPED'} />
          <button className="button compact secondary" disabled={!runbook.enabled || busy} onClick={() => beginRun(runbook)}>Run</button>
        </div>)}
      </div>}
    </details>

    {launchRunbook && <section className="workbench-section operation-launch">
      <div className="section-header"><h2>Start {launchRunbook.name}</h2><button className="button ghost" onClick={() => setLaunchRunbook(null)}>Cancel</button></div>
      <p className="form-note">Action <code>{launchRunbook.action}</code> in <code>{launchRunbook.environmentKey}</code> is evaluated by deterministic policy before execution.</p>
      <form onSubmit={submitRun}>
        {Object.keys(parameters).length === 0 ? <p className="muted">This runbook has no runtime parameters.</p> : Object.keys(parameters).map((name) => <label key={name}>{name}<input required className="mono" value={parameters[name]} onChange={(event) => setParameters((current) => ({ ...current, [name]: event.target.value }))} /></label>)}
        <footer className="form-actions"><button className="button primary" disabled={busy}>Request run</button></footer>
      </form>
    </section>}

    <section className="workbench-section operations-runs">
      <div className="section-header"><div><h2>Active runs</h2></div><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>
      {!visibleRuns.length ? <div className="empty"><strong>No operation runs</strong><p>Operational Agent and operator requests will appear here with policy and execution evidence.</p></div> : <div className="data-list">
        {visibleRuns.map((run) => <div className="data-row task-detail-row" key={run.id}>
          <div><strong>{runbookById.get(run.runbookId)?.name ?? run.action}</strong><small>{projectById.get(run.projectId)?.name} / {shortId(run.id)}</small></div>
          <Status value={run.status} /><span>{run.policyEffect}</span><span>{run.environmentKey}</span><time>{new Date(run.createdAt).toLocaleString()}</time>
          <div className="top-actions">
            <button className="button compact ghost" disabled={busy} onClick={() => void selectRun(run.id)}>Evidence</button>
            {run.status === 'WAITING_APPROVAL' && <button className="button compact primary" disabled={busy} onClick={() => void mutate(() => api.approveOperation(run.id))}>Approve</button>}
            {run.status === 'WAITING_APPROVAL' && <button className="button compact secondary" disabled={busy} onClick={() => void mutate(() => api.declineOperation(run.id))}>Decline</button>}
          </div>
        </div>)}
      </div>}
    </section>

    {selectedRun && <aside className="inspector operation-inspector">
      <div className="section-header"><div><h2>Selected operation: {shortId(selectedRun.run.id)} / {selectedRun.run.action}</h2></div><button className="button ghost" onClick={() => { setSelectedRun(null); setExternalWaits([]); }}>Close</button></div>
      {externalWaits.length > 0 && <>
        <h3>External waits</h3>
        <div className="data-list">
          {externalWaits.map((wait) => <div className="data-row task-row" key={wait.id}>
            <div><strong>{wait.workflow}</strong><small>{wait.repository} / {wait.mode}</small></div>
            <Status value={wait.status} />
            <code title={wait.expectedHeadSha}>{shortId(wait.expectedHeadSha)}</code>
            <span>{wait.lastObservedStatus ?? 'awaiting event'}{wait.lastObservedConclusion ? ` / ${wait.lastObservedConclusion}` : ''}</span>
            {wait.externalUrl ? <a href={wait.externalUrl} target="_blank" rel="noreferrer">GitHub run {wait.externalRunId ?? ''}</a> : <span className="muted">Deadline {new Date(wait.deadline).toLocaleString()}</span>}
          </div>)}
        </div>
      </>}
      <h3>Runbook steps</h3>
      <div className="data-list">
        {selectedRun.steps.length === 0 ? <div className="empty"><strong>No steps executed yet</strong><p>Run status is {label(selectedRun.run.status)}.</p></div> : selectedRun.steps.map((step) => <div className="data-row task-row" key={step.id}>
          <div><strong>{step.stepName}</strong><small>{step.stepType} / {step.durationMs ?? 0} ms</small></div><Status value={step.status} /><span>{step.summary ?? '-'}</span><code title={step.evidence ?? undefined}>{step.evidence ? step.evidence.slice(0, 120) : '-'}</code>
        </div>)}
      </div>
      {selectedRun.run.lastError && <div className="error-banner"><strong>Run error</strong><span>{selectedRun.run.lastError}</span></div>}
    </aside>}

    <details className="secondary-section operations-cleanup">
      <summary>Coding worktrees <span className="muted">Safe cleanup only</span></summary>
      {!visibleCodingAgents.length ? <div className="empty"><strong>No isolated coding worktrees</strong><p>System-managed Operational Agents use the shared project workspace.</p></div> : <div className="data-list">
        {visibleCodingAgents.map((agent) => <div className="data-row task-detail-row" key={agent.id}>
          <div><strong>{agent.name}</strong><small>{projectById.get(agent.projectId)?.name}</small></div>
          <Status value={agent.status} /><code>{agent.branch ?? '-'}</code><span>{new Date(agent.updatedAt).toLocaleString()}</span>
          <span className="muted">{agent.workspaceMode}</span>
          <button className="button compact secondary" disabled={busy} onClick={() => void cleanup(agent)}>Cleanup if safe</button>
        </div>)}
      </div>}
    </details>

    <details className="secondary-section operations-cleanup-history">
      <summary>Recent workspace cleanup</summary>
      {!cleanupHistory.length ? <div className="empty"><strong>No worktrees cleaned yet</strong><p>Merged, clean, inactive coding worktrees become eligible after the configured retention period.</p></div> : <div className="data-list">
        {cleanupHistory.slice(0, 20).map((record) => <div className="data-row task-row" key={record.id}>
          <div><strong>{record.branch ?? 'worktree'}</strong><small>{projectById.get(record.projectId)?.name}</small></div><Status value={record.outcome} /><span>{record.reason}</span><span>{humanBytes(record.freedBytes)}</span><time>{new Date(record.createdAt).toLocaleString()}</time>
        </div>)}
      </div>}
    </details>
  </div>;
}
