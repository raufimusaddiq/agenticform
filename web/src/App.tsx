import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { consumeAgentStream, consumeControlPlaneEvents } from './controlPlaneEvents';
import { ApprovalsView } from './ApprovalsView';
import { MessagesView } from './MessagesView';
import { OperationsView } from './OperationsView';
import { PolicyView } from './PolicyView';
import { ConnectionStatus, HumanControlIndicator, LoadingState, Status, label, shortId, type ConnectionState } from './ui';
import type {
  Agent,
  AgentCapabilityProfile,
  AgentTemplate,
  AgentMessage,
  AgentQueueMode,
  HumanApproval,
  HumanControlMode,
  PolicyRule,
  Project,
  Task,
  WorkspaceMode,
  CommunicationRule,
  RuntimeType
} from './types';
import './approvals.css';
import './human-control.css';
import './tasks.css';
import './project.css';

type View = 'overview' | 'projects' | 'agents' | 'tasks' | 'messages' | 'operations' | 'approvals' | 'policy';
type Dialog = 'project' | 'project-edit' | 'agent' | 'task' | null;
type ProjectCandidate = { name: string; path: string; configuredRoot: string; detectedBranch: string | null; registered: boolean };

const nav: Array<{ id: View; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'projects', label: 'Projects' },
  { id: 'agents', label: 'Agents' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'messages', label: 'Messages' },
  { id: 'operations', label: 'Operations' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'policy', label: 'Policy' }
];

const routeByView: Record<View, string> = {
  overview: '/', projects: '/projects', agents: '/agents', tasks: '/tasks',
  messages: '/messages', operations: '/operations', approvals: '/approvals', policy: '/policy'
};

function viewFromPath(pathname: string): View {
  const entry = Object.entries(routeByView).find(([, path]) => path === pathname);
  return (entry?.[0] as View | undefined) ?? 'overview';
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', closeOnEscape); };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div><p className="eyebrow">Agenticform</p><h2>{title}</h2></div>
          <button className="button ghost" type="button" onClick={onClose}>Close</button>
        </header>
        {children}
      </section>
    </div>
  );
}

export default function App({ onOpenNodes }: { onOpenNodes?: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentTemplates, setAgentTemplates] = useState<AgentTemplate[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [approvals, setApprovals] = useState<HumanApproval[]>([]);
  const [policyRules, setPolicyRules] = useState<PolicyRule[]>([]);
  const [communicationRules, setCommunicationRules] = useState<CommunicationRule[]>([]);
  const [projectCandidates, setProjectCandidates] = useState<ProjectCandidate[]>([]);
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname));
  const [projectFilter, setProjectFilter] = useState('all');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('CONNECTING');

  const navigate = useCallback((nextView: View) => {
    const path = routeByView[nextView];
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setView(nextView);
  }, []);

  useEffect(() => {
    const onPopState = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [nextProjects, nextAgents, nextAgentTemplates, nextTasks, nextMessages, nextApprovals, nextPolicyRules, nextCommunicationRules] = await Promise.all([
        api.projects(), api.agents(), api.agentTemplates(), api.tasks(), api.messages(), api.approvals(), api.policyRules(), api.communicationRules()
      ]);
      setProjects(nextProjects);
      setAgents(nextAgents);
      setAgentTemplates(nextAgentTemplates);
      setTasks(nextTasks);
      setMessages(nextMessages);
      setApprovals(nextApprovals);
      setPolicyRules(nextPolicyRules);
      setCommunicationRules(nextCommunicationRules);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load Agenticform state');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const controller = new AbortController();
    let stopped = false;
    let reconnectTimer: number | undefined;
    let refreshTimer: number | undefined;

    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(true), 125);
    };

    const reconnectDelay = () => new Promise<void>((resolve) => {
      reconnectTimer = window.setTimeout(resolve, 1500);
    });

    const connect = async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          await consumeControlPlaneEvents(() => scheduleRefresh(), controller.signal, setConnection);
        } catch (cause) {
          if (controller.signal.aborted || stopped) return;
          if (cause instanceof Error && cause.message === 'ADMIN_AUTH_REQUIRED') {
            setConnection('AUTH_REQUIRED');
            setError('ADMIN_AUTH_REQUIRED');
            return;
          }
          setConnection('RECONNECTING');
        }
        if (!stopped && !controller.signal.aborted) {
          setConnection('RECONNECTING');
          await reconnectDelay();
        }
      }
    };

    void connect();

    let agentStopped = false;
    let agentReconnectTimer: number | undefined;
    const connectAgents = async () => {
      while (!agentStopped && !controller.signal.aborted) {
        try {
          await consumeAgentStream(setAgents, controller.signal, (state) => { if (state === 'CONNECTED') setConnection(state); });
        } catch (cause) {
          if (controller.signal.aborted || agentStopped) return;
          if (cause instanceof Error && cause.message === 'ADMIN_AUTH_REQUIRED') { setError(cause.message); return; }
        }
        if (!agentStopped && !controller.signal.aborted) {
          await new Promise<void>((resolve) => { agentReconnectTimer = window.setTimeout(resolve, 1500); });
        }
      }
    };
    void connectAgents();
    return () => {
      stopped = true;
      agentStopped = true;
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (agentReconnectTimer !== undefined) window.clearTimeout(agentReconnectTimer);
    };
  }, [refresh]);

  const visibleAgents = useMemo(() => projectFilter === 'all' ? agents : agents.filter((agent) => agent.projectId === projectFilter), [agents, projectFilter]);
  const visibleTasks = useMemo(() => projectFilter === 'all' ? tasks : tasks.filter((task) => task.projectId === projectFilter), [tasks, projectFilter]);
  const visibleMessages = useMemo(() => projectFilter === 'all' ? messages : messages.filter((message) => message.projectId === projectFilter), [messages, projectFilter]);
  const visibleApprovals = useMemo(() => projectFilter === 'all' ? approvals : approvals.filter((approval) => approval.projectId === projectFilter), [approvals, projectFilter]);
  const taskAgents = useMemo(() => (visibleAgents.length ? visibleAgents : agents).filter((agent) => agent.role !== 'OPERATIONAL'), [visibleAgents, agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const attention = agents.filter((agent) => ['WAITING_APPROVAL', 'BLOCKED', 'DISCONNECTED', 'FAILED'].includes(agent.status)).length
    + tasks.filter((task) => ['WAITING_APPROVAL', 'BLOCKED', 'FAILED'].includes(task.status)).length
    + messages.filter((message) => message.status === 'FAILED').length
    + approvals.filter((approval) => approval.status === 'PENDING').length;
  const active = agents.filter((agent) => agent.status === 'WORKING').length;
  const queued = tasks.filter((task) => ['READY', 'DISPATCHING', 'DISPATCHED'].includes(task.status)).length;

  async function mutate(work: () => Promise<unknown>) {
    try {
      setError(null);
      await work();
      setDialog(null);
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action failed');
    }
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand"><span className="brand-mark" aria-hidden="true">A</span><div><strong>Agenticform</strong><small>control plane</small></div></div>
        <div className="nav-caption">Workspace</div>
        <nav>
          {nav.slice(0, 4).map((item) => <button type="button" key={item.id} className={view === item.id ? 'nav-item active' : 'nav-item'} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>{item.label}</button>)}
        </nav>
        <div className="nav-caption nav-caption-spaced">Supervision</div>
        <nav>
          {nav.slice(4).map((item) => <button type="button" key={item.id} className={view === item.id ? 'nav-item active' : 'nav-item'} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>{item.label}{item.id === 'approvals' && approvals.some((approval) => approval.status === 'PENDING') && <span className="nav-count">{approvals.filter((approval) => approval.status === 'PENDING').length}</span>}</button>)}
        </nav>
        <div className="sidebar-footer"><ConnectionStatus state={connection} /></div>
      </aside>

      <main id="main-content" className="workspace">
        <header className="topbar">
          <div className="page-heading"><p className="eyebrow">{projectFilter === 'all' ? 'All projects' : projectById.get(projectFilter)?.name}</p><h1>{nav.find((item) => item.id === view)?.label}</h1></div>
          <div className="top-actions">
            <select aria-label="Project filter" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value="all">All projects</option>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
            {onOpenNodes && <button className="button secondary" type="button" onClick={onOpenNodes}>Execution nodes</button>}
            <button className="button secondary" type="button" onClick={() => setDialog('task')} disabled={!taskAgents.length}>New task</button>
            <button className="button primary" type="button" onClick={() => setDialog('agent')} disabled={!projects.length}>Spawn agent</button>
          </div>
        </header>

        {error && <div className="error-banner" role="alert"><strong>Action required</strong><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {loading ? <LoadingState label="Loading control-plane state" /> : (
          <>
            {view === 'overview' && <Overview projects={projects} agents={visibleAgents} tasks={visibleTasks} messages={visibleMessages} approvals={visibleApprovals} attention={attention} active={active} queued={queued} connection={connection} projectById={projectById} agentById={agentById} onRegister={() => setDialog('project')} onOpenNodes={onOpenNodes} onOpenApprovals={() => navigate('approvals')} onOpenAgents={() => navigate('agents')} onOpenTasks={() => navigate('tasks')} onSpawn={() => setDialog('agent')} />}
            {view === 'projects' && <Projects projects={projects} agents={agents} tasks={tasks} candidates={projectCandidates} onRegister={() => setDialog('project')} onEdit={(projectId) => { setEditingProjectId(projectId); setDialog('project-edit'); }} onDiscover={() => void mutate(async () => setProjectCandidates(await api.discoverProjects()))} onRegisterCandidate={(candidate) => void mutate(() => api.registerProject({ name: candidate.name, path: candidate.path, defaultBranch: candidate.detectedBranch || 'main' }))} onEnsureSystemAgents={(projectId) => void mutate(() => api.ensureOperationalAgent(projectId))} />}
            {view === 'agents' && <Agents agents={visibleAgents} tasks={visibleTasks} projectById={projectById} onControlMode={(id, mode) => void mutate(() => api.updateHumanControlMode(id, mode))} onQueueMode={(id, mode) => void mutate(() => api.updateQueueMode(id, mode))} onIntervene={(id) => void mutate(() => api.intervene(id))} onRestart={(id) => void mutate(() => api.restartRuntime(id))} />}
            {view === 'tasks' && <Tasks tasks={visibleTasks} projectById={projectById} agentById={agentById} onDispatch={(id) => void mutate(() => api.dispatchTask(id))} onCreate={() => setDialog('task')} />}
            {view === 'messages' && <MessagesView messages={visibleMessages} agents={visibleAgents.length ? visibleAgents : agents} projects={projects} communicationRules={communicationRules} onSend={async (input) => { await mutate(() => api.sendMessage(input)); }} onSaveRule={async (input) => { await mutate(() => api.saveCommunicationRule(input)); }} onDeleteRule={async (id) => { await mutate(() => api.deleteCommunicationRule(id)); }} />}
            {view === 'operations' && <OperationsView projects={projects} agents={agents} projectFilter={projectFilter} />}
            {view === 'approvals' && <ApprovalsView approvals={visibleApprovals} agents={agents} projects={projects} onDecision={async (id, decision) => { await mutate(() => api.decideApproval(id, decision)); }} onAnswer={async (id, answers) => { await mutate(() => api.answerApproval(id, answers)); }} />}
            {view === 'policy' && <PolicyView rules={policyRules} projects={projects} agents={agents} tasks={tasks} onCreate={async (input) => { await mutate(() => api.createPolicyRule(input)); }} onUpdate={async (id, input) => { await mutate(() => api.updatePolicyRule(id, input)); }} onDelete={async (id) => { await mutate(() => api.deletePolicyRule(id)); }} onEvaluate={(input) => api.evaluatePolicy(input)} />}
          </>
        )}
      </main>

      {dialog === 'project' && <ProjectForm onClose={() => setDialog(null)} onSubmit={(input) => mutate(() => api.registerProject(input))} />}
      {dialog === 'project-edit' && editingProjectId && <ProjectEditForm project={projects.find((item) => item.id === editingProjectId)!} onClose={() => { setDialog(null); setEditingProjectId(null); }} onSubmit={(input) => mutate(() => api.updateProject(editingProjectId, input))} />}
      {dialog === 'agent' && <AgentForm projects={projects} templates={agentTemplates} initialProjectId={projectFilter === 'all' ? projects[0]?.id : projectFilter} onClose={() => setDialog(null)} onSubmit={(input) => mutate(() => api.spawnAgent(input))} />}
      {dialog === 'task' && <TaskForm agents={taskAgents} onClose={() => setDialog(null)} onSubmit={(input) => mutate(() => api.createTask(input))} />}
    </div>
  );
}

function Overview({ projects, agents, tasks, messages, approvals, attention, active, queued, connection, projectById, agentById, onRegister, onOpenNodes, onOpenApprovals, onOpenAgents, onOpenTasks, onSpawn }: {
  projects: Project[]; agents: Agent[]; tasks: Task[]; messages: AgentMessage[]; approvals: HumanApproval[]; attention: number; active: number; queued: number; connection: ConnectionState;
  projectById: Map<string, Project>; agentById: Map<string, Agent>; onRegister: () => void; onOpenNodes?: () => void; onOpenApprovals: () => void; onOpenAgents: () => void; onOpenTasks: () => void; onSpawn: () => void;
}) {
  const recent = [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 8);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'PENDING');
  const unhealthyAgents = agents.filter((agent) => ['WAITING_APPROVAL', 'BLOCKED', 'DISCONNECTED', 'FAILED'].includes(agent.status));
  const blockedTasks = tasks.filter((task) => ['WAITING_APPROVAL', 'BLOCKED', 'FAILED'].includes(task.status));
  const running = agents.filter((agent) => agent.status === 'WORKING');
  const queue = [['Running', tasks.filter((task) => ['RUNNING', 'DISPATCHING', 'DISPATCHED'].includes(task.status)).length], ['Waiting', tasks.filter((task) => ['QUEUED', 'READY', 'WAITING_DEPENDENCY'].includes(task.status)).length], ['Needs approval', tasks.filter((task) => task.status === 'WAITING_APPROVAL').length], ['Blocked / paused', tasks.filter((task) => ['BLOCKED', 'PAUSED'].includes(task.status)).length], ['Completed', tasks.filter((task) => task.status === 'COMPLETED').length], ['Failed / cancelled', tasks.filter((task) => ['FAILED', 'CANCELLED'].includes(task.status)).length]];
  const activity = [
    ...tasks.map((task) => ({ id: `task-${task.id}`, title: task.title, detail: `Task ${label(task.status)}`, status: task.status, at: task.updatedAt })),
    ...approvals.map((approval) => ({ id: `approval-${approval.id}`, title: approval.summary, detail: `Approval ${label(approval.status)}`, status: approval.status, at: approval.resolvedAt ?? approval.createdAt })),
    ...messages.map((message) => ({ id: `message-${message.id}`, title: message.subject, detail: `Message ${label(message.status)}`, status: message.status, at: message.updatedAt }))
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 8);
  const attentionRows = [...pendingApprovals.map((approval) => ({ id: `approval-${approval.id}`, title: approval.summary, agent: agentById.get(approval.agentId)?.name ?? shortId(approval.agentId), reason: 'Approval required', open: onOpenApprovals })), ...blockedTasks.map((task) => ({ id: `task-${task.id}`, title: task.title, agent: agentById.get(task.assignedAgentId)?.name ?? 'Unknown agent', reason: label(task.status), open: onOpenTasks })), ...unhealthyAgents.map((agent) => ({ id: `agent-${agent.id}`, title: agent.name, agent: agent.name, reason: label(agent.status), open: onOpenAgents }))].slice(0, 8);
  return <div className="workbench-page">
    {!projects.length && <section className="setup-panel" aria-labelledby="setup-title">
      <div><p className="eyebrow">First run</p><h2 id="setup-title">Set up a project workspace</h2><p>Register a Git repository, enroll an execution node, then assign the first agent.</p></div>
      <div className="setup-actions"><button className="button primary" onClick={onRegister}>Register repository</button><button className="button secondary" onClick={onOpenNodes}>Add execution node</button></div>
    </section>}
    <section className="workbench-section"><div className="section-header"><h2>Needs attention</h2>{attention > 0 && <button className="button ghost" onClick={onOpenApprovals}>{attention} need attention · Review all</button>}</div>{!attentionRows.length ? <Empty title="No action required" body="Approvals, failures, and blocked work appear here." /> : <div className="workbench-table attention-table"><div className="table-head"><span>Item / task</span><span>Agent</span><span>Reason</span><span>Action</span></div>{attentionRows.map((row) => <button className="table-row" key={row.id} onClick={row.open}><span>{row.title}</span><span>{row.agent}</span><span>{row.reason}</span><span>Open</span></button>)}</div>}</section>
    <section className="workbench-section"><div className="section-header"><h2>Running</h2><button className="button ghost" onClick={projects.length ? onSpawn : onRegister}>{projects.length ? 'Spawn agent' : 'Register project'}</button></div>{!running.length ? <Empty title="No active agents" body="Running agents appear here." /> : <div className="workbench-table"><div className="table-head"><span>Agent</span><span>Project</span><span>Current task</span><span>Elapsed</span></div>{running.map((agent) => <div className="table-row" key={agent.id}><span>{agent.name}</span><span>{projectById.get(agent.projectId)?.name ?? 'Unknown project'}</span><span>{agent.activeTaskId ? tasks.find((task) => task.id === agent.activeTaskId)?.title ?? 'Working' : 'Working'}</span><time title={new Date(agent.updatedAt).toLocaleString()}>{relativeTime(agent.updatedAt)}</time></div>)}</div>}</section>
    <section className="workbench-section"><div className="section-header"><h2>Queue</h2></div><div className="queue-line">{queue.map(([name, count]) => <span key={name}>{name} <strong>{count}</strong></span>)}</div></section>
    <section className="workbench-section"><div className="section-header"><h2>Recent activity</h2></div>{!activity.length ? <Empty title="No activity yet" body="Task transitions, approvals, and messages appear here." /> : <div className="activity-list">{activity.map((item) => <div className="activity-row" key={item.id}><time title={new Date(item.at).toLocaleString()}>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><strong>{item.title}</strong><span>{item.detail}</span></div>)}</div>}</section>
    <section className="workbench-section"><div className="section-header"><h2>System health</h2></div><div className="health-list"><div><span>Control plane</span><ConnectionStatus state={connection} /></div><div><span>Agents</span><strong>{active} working / {agents.filter((agent) => ['WAITING_APPROVAL', 'BLOCKED'].includes(agent.status)).length} waiting</strong></div><div><span>Queue</span><strong>{queued} waiting</strong></div><div><span>Projects</span><strong>{projects.length} registered</strong></div></div></section>
  </div>;
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function Projects({ projects, agents, tasks, candidates, onRegister, onEdit, onDiscover, onRegisterCandidate, onEnsureSystemAgents }: { projects: Project[]; agents: Agent[]; tasks: Task[]; candidates: ProjectCandidate[]; onRegister: () => void; onEdit: (projectId: string) => void; onDiscover: () => void; onRegisterCandidate: (candidate: ProjectCandidate) => void; onEnsureSystemAgents: (projectId: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const selected = projects.find((project) => project.id === selectedId);
  return <section className="panel"><div className="section-header"><div><h2>Projects</h2></div><div className="form-actions"><button className="button secondary" onClick={onDiscover}>Scan roots</button><button className="button primary" onClick={onRegister}>Register project</button></div></div>
    {!projects.length ? <Empty title="No projects registered" body="Register a repository under an allowed server root." /> : <div className="split-workbench"><div className="workbench-table project-table"><div className="table-head"><span>Project</span><span>Repository / directory</span><span>Branch</span><span>Agents</span><span>Active work</span><span>Health</span></div>
      {projects.map((project) => {
        const projectAgents = agents.filter((agent) => agent.projectId === project.id);
        const ops = projectAgents.find((agent) => agent.role === 'OPERATIONAL');
        const orchestrator = projectAgents.find((agent) => agent.role === 'ORCHESTRATOR');
        const openTasks = tasks.filter((task) => task.projectId === project.id && !['COMPLETED', 'CANCELLED'].includes(task.status));
        const unhealthy = projectAgents.some((agent) => ['FAILED', 'DISCONNECTED', 'BLOCKED'].includes(agent.status));
        return <button className={`table-row${selectedId === project.id ? ' selected' : ''}`} key={project.id} onClick={() => setSelectedId(project.id)}>
          <span>{project.name}</span><code title={(project.sourceType === 'GIT' ? project.repositoryUrl : project.rootDirectory) ?? undefined}>{project.sourceType === 'GIT' ? project.repositoryUrl : project.rootDirectory}</code><code>{project.defaultBranch}</code><span>{projectAgents.length}</span><span>{openTasks.length}</span><Status value={unhealthy ? 'FAILED' : 'IDLE'} />
        </button>;
      })}
    </div><aside className="inspector">{selected ? <><h3>{selected.name}</h3><dl><dt>Source</dt><dd>{selected.sourceType}</dd><dt>Location</dt><dd><code>{selected.sourceType === 'GIT' ? selected.repositoryUrl : selected.rootDirectory}</code></dd><dt>Branch</dt><dd><code>{selected.defaultBranch}</code></dd><dt>Agents</dt><dd>{agents.filter((agent) => agent.projectId === selected.id).length}</dd><dt>Open tasks</dt><dd>{tasks.filter((task) => task.projectId === selected.id && !['COMPLETED', 'CANCELLED'].includes(task.status)).length}</dd><dt>GitHub token</dt><dd>{selected.githubTokenConfigured ? 'Configured' : 'Not configured'}</dd><dt>System agents</dt><dd>{(() => { const scoped = agents.filter((agent) => agent.projectId === selected.id); return scoped.some((agent) => agent.role === 'OPERATIONAL') && scoped.some((agent) => agent.role === 'ORCHESTRATOR') ? 'Ready' : 'Not provisioned'; })()}</dd></dl><div className="form-actions"><button className="button secondary" onClick={() => onEdit(selected.id)}>Manage project</button>{(() => { const scoped = agents.filter((agent) => agent.projectId === selected.id); return (!scoped.some((agent) => agent.role === 'OPERATIONAL') || !scoped.some((agent) => agent.role === 'ORCHESTRATOR')) && <button className="button compact secondary" onClick={() => onEnsureSystemAgents(selected.id)}>Enable system agents</button>; })()}</div></> : <p className="muted">Select a project.</p>}</aside></div>}
    {candidates.length > 0 && <div className="data-list"><div className="section-header"><div><p className="eyebrow">Discovery results</p><h2>Repositories</h2></div></div>{candidates.map((candidate) => <div className="data-row" key={candidate.path}><div><strong>{candidate.name}</strong><code>{candidate.path}</code></div><span>{candidate.detectedBranch || 'main'}</span><span>{candidate.registered ? 'Registered' : 'Unregistered'}</span>{!candidate.registered && <button className="button compact secondary" onClick={() => onRegisterCandidate(candidate)}>Register</button>}</div>)}</div>}
  </section>;
}

function Agents({ agents, tasks, projectById, onControlMode, onQueueMode, onIntervene, onRestart }: {
  agents: Agent[]; tasks: Task[];
  projectById: Map<string, Project>;
  onControlMode: (id: string, mode: HumanControlMode) => void;
  onQueueMode: (id: string, mode: AgentQueueMode) => void;
  onIntervene: (id: string) => void;
  onRestart: (id: string) => void;
}) {
  const working = agents.filter((agent) => agent.status === 'WORKING').length;
  const blocked = agents.filter((agent) => ['BLOCKED', 'WAITING_APPROVAL', 'FAILED', 'DISCONNECTED'].includes(agent.status)).length;
  const [selectedId, setSelectedId] = useState<string | null>(agents[0]?.id ?? null);
  const selected = agents.find((agent) => agent.id === selectedId);
  return <section className="panel"><div className="section-header"><div><h2>Agents</h2></div></div>
    <div className="inline-summary"><span>{working} working</span><span>{blocked} attention</span><span>{agents.length} total</span></div>
    {!agents.length ? <Empty title="No agents match this scope" body="Spawn an agent from the current project selection." /> : <div className="split-workbench"><div className="workbench-table agent-table"><div className="table-head"><span>Agent</span><span>State</span><span>Current work</span><span>Project</span><span>Supervision</span></div>{agents.map((agent) => <button className={`table-row${selectedId === agent.id ? ' selected' : ''}`} key={agent.id} onClick={() => setSelectedId(agent.id)}><span>{agent.name}</span><Status value={agent.status} /><span>{tasks.find((task) => task.id === agent.activeTaskId)?.title ?? '-'}</span><span>{projectById.get(agent.projectId)?.name ?? 'Unknown project'}</span><HumanControlIndicator mode={agent.humanControlMode} /></button>)}</div><aside className="inspector">{selected ? <><h3>Selected agent</h3><Status value={selected.status} /><dl><dt>Current task</dt><dd>{tasks.find((task) => task.id === selected.activeTaskId)?.title ?? '-'}</dd><dt>Project</dt><dd>{projectById.get(selected.projectId)?.name ?? 'Unknown project'}</dd><dt>Supervision</dt><dd><select className="compact-select" value={selected.humanControlMode} onChange={(event) => onControlMode(selected.id, event.target.value as HumanControlMode)}><option value="ON_THE_LOOP">Human on the loop</option><option value="IN_THE_LOOP">Human in the loop</option></select></dd><dt>Responsibility</dt><dd>{selected.responsibility}</dd><dt>Capability</dt><dd>{selected.capabilityProfile}</dd><dt>Runtime</dt><dd>{selected.runtimeType}</dd><dt>Session</dt><dd><code>{shortId(selected.runtimeSessionId)}</code></dd><dt>Turn</dt><dd><code>{shortId(selected.activeTurnId)}</code></dd><dt>Directory</dt><dd><code>{selected.workingDirectory}</code></dd><dt>Branch</dt><dd><code>{selected.branch ?? 'shared workspace'}</code></dd><dt>Execution node</dt><dd><code>{shortId(selected.executionNodeId)}</code></dd><dt>Queue mode</dt><dd><select className="compact-select" value={selected.queueMode} onChange={(event) => onQueueMode(selected.id, event.target.value as AgentQueueMode)}><option value="AUTO">Automatic</option><option value="REVIEW_BETWEEN_TASKS">Review between tasks</option><option value="PAUSED">Paused</option></select></dd></dl><div className="form-actions"><button className="button secondary" onClick={() => onIntervene(selected.id)} disabled={selected.queueMode === 'PAUSED' && !selected.activeTurnId}>Intervene</button><button className="button ghost" type="button" onClick={() => { if (window.confirm(`Restart ${selected.name}'s runtime? This creates a new Codex thread.`)) onRestart(selected.id); }} disabled={Boolean(selected.activeTaskId || selected.activeTurnId)}>Restart runtime</button></div></> : <p className="muted">Select an agent.</p>}</aside></div>}
  </section>;
}

function Tasks({ tasks, projectById, agentById, onDispatch, onCreate }: { tasks: Task[]; projectById: Map<string, Project>; agentById: Map<string, Agent>; onDispatch: (id: string) => void; onCreate: () => void }) {
  const [filter, setFilter] = useState('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(tasks[0]?.id ?? null);
  const [collapsedWorkflows, setCollapsedWorkflows] = useState<Set<string>>(new Set());
  const categories: Record<string, string[]> = { ALL: [], RUNNING: ['RUNNING', 'DISPATCHING', 'DISPATCHED'], WAITING: ['QUEUED', 'READY', 'WAITING_DEPENDENCY'], WAITING_APPROVAL: ['WAITING_APPROVAL'], BLOCKED: ['BLOCKED', 'PAUSED'], COMPLETED: ['COMPLETED'], FAILED: ['FAILED', 'CANCELLED'] };
  const visible = filter === 'ALL' ? tasks : tasks.filter((task) => categories[filter].includes(task.status));
  const selected = visible.find((task) => task.id === selectedId) ?? visible[0];
  useEffect(() => {
    if (selectedId && visible.some((task) => task.id === selectedId)) return;
    setSelectedId(visible[0]?.id ?? null);
  }, [filter, tasks, selectedId]);
  const groups = [...visible.reduce((result, task) => {
    const root = tasks.find((candidate) => candidate.workflowId === task.workflowId && !candidate.parentTaskId);
    const group = result.get(task.workflowId) ?? { workflowId: task.workflowId, parent: root ?? null, tasks: [] as Task[] };
    group.tasks.push(task);
    result.set(task.workflowId, group);
    return result;
  }, new Map<string, { workflowId: string; parent: Task | null; tasks: Task[] }>()).values()]
    .sort((a, b) => Math.max(...b.tasks.map((task) => Date.parse(task.updatedAt))) - Math.max(...a.tasks.map((task) => Date.parse(task.updatedAt))));
  const nextAction = (task: Task) => task.status === 'WAITING_APPROVAL' ? 'Review approval' : task.status === 'WAITING_DEPENDENCY' ? 'Wait dependency' : task.status === 'FAILED' ? 'Inspect failure' : task.status === 'BLOCKED' ? 'Review blocker' : '-';
  return <section className="panel"><div className="section-header"><h2>Tasks</h2><button className="button primary" onClick={onCreate}>New task</button></div><div className="filter-tabs">{[['ALL','All'],['RUNNING','Running'],['WAITING','Waiting'],['WAITING_APPROVAL','Needs approval'],['BLOCKED','Blocked'],['COMPLETED','Completed'],['FAILED','Failed']].map(([value, text]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{text}</button>)}</div>{!visible.length ? <Empty title="No tasks in this view" body="Choose another state or create a task." /> : <div className="split-workbench"><div className="workbench-table task-table"><div className="table-head"><span>Task</span><span>State</span><span>Agent</span><span>Project</span><span>Next action</span></div>{groups.map((group) => { const collapsed = collapsedWorkflows.has(group.workflowId); return <section className="task-group" key={group.workflowId}><header className="task-group-header"><button className="task-group-toggle" type="button" aria-expanded={!collapsed} onClick={() => setCollapsedWorkflows((current) => { const next = new Set(current); if (next.has(group.workflowId)) next.delete(group.workflowId); else next.add(group.workflowId); return next; })}><span aria-hidden="true">{collapsed ? '▸' : '▾'}</span><strong>{group.parent?.title ?? 'Workflow tasks'}</strong></button><code title={group.workflowId}>{shortId(group.workflowId)}</code><span>{group.tasks.length} related</span></header>{!collapsed && group.tasks.slice().sort((a, b) => Number(Boolean(a.parentTaskId)) - Number(Boolean(b.parentTaskId)) || Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((task) => <button className={`table-row${task.parentTaskId ? ' child-task' : ''}${selectedId === task.id ? ' selected' : ''}`} key={task.id} onClick={() => setSelectedId(task.id)}><span>{task.parentTaskId ? `↳ ${task.title}` : task.title}</span><Status value={task.status} /><span>{agentById.get(task.assignedAgentId)?.name ?? 'Unknown agent'}</span><span>{projectById.get(task.projectId)?.name ?? 'Unknown project'}</span><span>{nextAction(task)}</span></button>)}</section>; })}</div><aside className="inspector">{selected ? <><h3>Selected task</h3><Status value={selected.status} /><dl><dt>Assigned agent</dt><dd>{agentById.get(selected.assignedAgentId)?.name ?? 'Unknown agent'}</dd><dt>Project</dt><dd>{projectById.get(selected.projectId)?.name}</dd><dt>Priority</dt><dd>{selected.priority}</dd><dt>Next action</dt><dd>{nextAction(selected)}</dd><dt>Workflow</dt><dd><code>{shortId(selected.workflowId)}</code></dd><dt>Parent task</dt><dd><code>{shortId(selected.parentTaskId)}</code></dd><dt>Queue submission</dt><dd><code>{shortId(selected.queuedSubmissionId)}</code></dd><dt>Turn</dt><dd><code>{shortId(selected.turnId)}</code></dd><dt>Creation source</dt><dd className="muted">Not recorded by the API</dd></dl>{selected.report && <><h3>Report</h3><p>{selected.report}</p></>}{selected.lastError && <><h3>Failure</h3><p className="inline-error">{selected.lastError}</p></> }<button className="button secondary" disabled={!['READY', 'BLOCKED'].includes(selected.status)} onClick={() => onDispatch(selected.id)}>Dispatch</button></> : <p className="muted">Select a task.</p>}</aside></div>}</section>;
}

function Empty({ title, body }: { title: string; body: string }) { return <div className="empty"><strong>{title}</strong><p>{body}</p></div>; }

function ProjectForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: { name: string; sourceType: 'LOCAL_PATH' | 'GIT'; path?: string; repositoryUrl?: string; defaultBranch: string; githubToken?: string }) => void }) {
  const [sourceType, setSourceType] = useState<'LOCAL_PATH' | 'GIT'>('GIT');
  const [name, setName] = useState(''); const [path, setPath] = useState('/srv/apps/'); const [repositoryUrl, setRepositoryUrl] = useState(''); const [githubToken, setGithubToken] = useState(''); const [branch, setBranch] = useState('main');
  return <Modal title="Register project" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit(sourceType === 'GIT' ? { name, sourceType, repositoryUrl, defaultBranch: branch, githubToken: githubToken || undefined } : { name, sourceType, path, defaultBranch: branch }); }}>
    <label>Source<select value={sourceType} onChange={(event) => setSourceType(event.target.value as 'LOCAL_PATH' | 'GIT')}><option value="GIT">Git repository</option><option value="LOCAL_PATH">Server directory</option></select></label>
    <label>Project name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="My project" /></label>
    {sourceType === 'GIT' ? <><label>Repository URL<input required type="url" className="mono" value={repositoryUrl} onChange={(e) => setRepositoryUrl(e.target.value)} placeholder="https://github.com/org/repository.git" /><small>Use a credential-free HTTPS URL. Agents clone this repository on the selected node.</small></label><label>GitHub access token<input type="password" autoComplete="new-password" className="mono" value={githubToken} onChange={(e) => setGithubToken(e.target.value)} placeholder="Optional repository-scoped token" /><small>Encrypted in the control plane; never shown again or stored on nodes.</small></label></> : <label>Server directory<input required className="mono" value={path} onChange={(e) => setPath(e.target.value)} /><small>The backend validates this path against configured project roots.</small></label>}
    <label>Default branch<input required className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" /></label>
    <footer className="form-actions"><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary">Register project</button></footer>
  </form></Modal>;
}

function ProjectEditForm({ project, onClose, onSubmit }: { project: Project; onClose: () => void; onSubmit: (input: { name: string; defaultBranch: string; enabled: boolean; githubToken?: string }) => void }) {
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.defaultBranch);
  const [enabled, setEnabled] = useState(project.enabled);
  const [githubToken, setGithubToken] = useState('');
  return <Modal title="Manage project" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit({ name: name.trim(), defaultBranch: branch.trim(), enabled, githubToken: githubToken || undefined }); }}>
    <label>Project name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>Default branch<input required className="mono" value={branch} onChange={(event) => setBranch(event.target.value)} /></label>
    {project.sourceType === 'GIT' && <label>Replace GitHub access token<input type="password" autoComplete="new-password" className="mono" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder={project.githubTokenConfigured ? 'Token configured; leave blank to keep' : 'Optional repository-scoped token'} /><small>Token access and push permission are verified before saving.</small></label>}
    <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label>
    <footer className="form-actions"><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary">Validate and save</button></footer>
  </form></Modal>;
}

function AgentForm({ projects, templates, initialProjectId, onClose, onSubmit }: {
  projects: Project[];
  templates: AgentTemplate[];
  initialProjectId?: string;
  onClose: () => void;
  onSubmit: (input: { projectId: string; name: string; responsibility: string; runtimeType: RuntimeType; runtimeProfileId?: string; workspaceMode: WorkspaceMode; baseBranch?: string; branch?: string; queueMode: AgentQueueMode; humanControlMode: HumanControlMode; capabilityProfile: AgentCapabilityProfile; templateId?: string }) => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? '');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [name, setName] = useState(templates[0]?.displayName ?? '');
  const [responsibility, setResponsibility] = useState(templates[0]?.responsibility ?? '');
  const [runtimeType, setRuntimeType] = useState<RuntimeType>('CODEX');
  const [runtimeProfileId, setRuntimeProfileId] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('ISOLATED_WORKTREE');
  const [branch, setBranch] = useState('');
  const [queueMode, setQueueMode] = useState<AgentQueueMode>('AUTO');
  const [humanControlMode, setHumanControlMode] = useState<HumanControlMode>('ON_THE_LOOP');
  const [capabilityProfile, setCapabilityProfile] = useState<AgentCapabilityProfile>(templates[0]?.capabilityProfile ?? 'IMPLEMENTER');
  const project = projects.find((item) => item.id === projectId);
  const template = templates.find((item) => item.id === templateId);
  useEffect(() => {
    if (!template) return;
    setName(template.displayName);
    setResponsibility(template.responsibility);
    setCapabilityProfile(template.capabilityProfile);
  }, [template]);
  return <Modal title="Spawn agent" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit({ projectId, name, responsibility, runtimeType, runtimeProfileId: runtimeProfileId.trim() || undefined, workspaceMode, baseBranch: project?.defaultBranch, branch: branch || undefined, queueMode, humanControlMode, capabilityProfile, templateId: templateId || undefined }); }}>
    <label>Project<select required value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>Template<select value={templateId} onChange={(e) => setTemplateId(e.target.value)}><option value="">Custom</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <label>Agent name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Backend Auth" /></label>
    <label>Responsibility<textarea required rows={5} value={responsibility} onChange={(e) => setResponsibility(e.target.value)} placeholder="Own authentication, token lifecycle, backend API and tests." /></label>
    <label>Runtime<select required value={runtimeType} onChange={(e) => setRuntimeType(e.target.value as RuntimeType)}><option value="CODEX">Codex</option></select></label>
    <label>Runtime profile <span className="optional">optional</span><input className="mono" value={runtimeProfileId} onChange={(e) => setRuntimeProfileId(e.target.value)} placeholder="default" /></label>
    <div className="form-grid"><label>Workspace<select value={workspaceMode} onChange={(e) => setWorkspaceMode(e.target.value as WorkspaceMode)}><option value="ISOLATED_WORKTREE">Isolated worktree</option><option value="SHARED_PROJECT">Shared project</option></select></label><label>Queue policy<select value={queueMode} onChange={(e) => setQueueMode(e.target.value as AgentQueueMode)}><option value="AUTO">Automatic</option><option value="REVIEW_BETWEEN_TASKS">Review between tasks</option><option value="PAUSED">Paused</option></select></label></div>
    <label>Human control<select value={humanControlMode} onChange={(e) => setHumanControlMode(e.target.value as HumanControlMode)}><option value="ON_THE_LOOP">Human on the loop / autonomous by default</option><option value="IN_THE_LOOP">Human in the loop / all approvals block</option></select></label>
    <label>Capability profile<select value={capabilityProfile} onChange={(e) => setCapabilityProfile(e.target.value as AgentCapabilityProfile)}><option value="IMPLEMENTER">Implementer / read, write, test, commit, message</option><option value="REVIEWER">Reviewer / read, test, review, message</option><option value="ARCHITECT">Architect / read, message</option><option value="ORCHESTRATOR">Orchestrator / read, message, delegate</option><option value="OPS">Ops / read, test, message, deploy</option></select></label>
    <p className="form-note">On-the-loop is the default. Deterministic policy rules decide which actions continue, require you, or are denied; full HITL only tightens allowed actions. A system-managed Operational Agent is provisioned automatically for operational handoffs.</p>
    <label>Agent branch <span className="optional">optional</span><input className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="agent/backend-auth" /></label>
    <footer className="form-actions"><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary">Spawn agent</button></footer>
  </form></Modal>;
}

function TaskForm({ agents, onClose, onSubmit }: { agents: Agent[]; onClose: () => void; onSubmit: (input: { agentId: string; title: string; prompt: string; priority: number }) => void }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? ''); const [title, setTitle] = useState(''); const [prompt, setPrompt] = useState(''); const [priority, setPriority] = useState(0);
  return <Modal title="Create task" onClose={onClose}><form onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit({ agentId, title, prompt, priority }); }}>
    <label>Agent<select required value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} / {label(agent.status)} / {agent.humanControlMode === 'IN_THE_LOOP' ? 'HITL' : 'HOTL'}</option>)}</select></label>
    <label>Title<input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Implement refresh-token fallback" /></label>
    <label>Instruction<textarea required rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Inspect the current token lifecycle, implement the fallback, add tests, and report any compatibility risks." /></label>
    <label>Priority<input type="number" min="-100" max="100" value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></label>
    <footer className="form-actions"><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary">Create task</button></footer>
  </form></Modal>;
}
