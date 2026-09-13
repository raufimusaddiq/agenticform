import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { consumeAgentStream, consumeControlPlaneEvents } from './controlPlaneEvents';
import { ApprovalsView } from './ApprovalsView';
import { MessagesView } from './MessagesView';
import { OperationsView } from './OperationsView';
import { PolicyView } from './PolicyView';
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

type View = 'overview' | 'projects' | 'agents' | 'tasks' | 'messages' | 'operations' | 'approvals' | 'policy';
type Dialog = 'project' | 'agent' | 'task' | null;
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

const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const shortId = (value: string | null) => (value ? `${value.slice(0, 8)}...` : '-');

function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}><span className="status-dot" />{label(value)}</span>;
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
  const [view, setView] = useState<View>('overview');
  const [projectFilter, setProjectFilter] = useState('all');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          await consumeControlPlaneEvents(() => scheduleRefresh(), controller.signal);
        } catch (cause) {
          if (controller.signal.aborted || stopped) return;
          if (cause instanceof Error && cause.message === 'ADMIN_AUTH_REQUIRED') {
            setError('ADMIN_AUTH_REQUIRED');
            return;
          }
        }
        if (!stopped && !controller.signal.aborted) await reconnectDelay();
      }
    };

    void connect();

    let agentStopped = false;
    let agentReconnectTimer: number | undefined;
    const connectAgents = async () => {
      while (!agentStopped && !controller.signal.aborted) {
        try {
          await consumeAgentStream(setAgents, controller.signal);
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
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">A</span><div><strong>Agenticform</strong><small>control plane</small></div></div>
        <nav>
          {nav.map((item) => <button key={item.id} className={view === item.id ? 'nav-item active' : 'nav-item'} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}>{item.label}</button>)}
        </nav>
        <div className="sidebar-footer"><span className="live-dot" />Live control plane</div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Server orchestration</p><h1>{nav.find((item) => item.id === view)?.label}</h1></div>
          <div className="top-actions">
            <select aria-label="Project filter" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value="all">All projects</option>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
            {onOpenNodes && <button className="button secondary" onClick={onOpenNodes}>Execution nodes</button>}
            <button className="button secondary" onClick={() => setDialog('task')} disabled={!taskAgents.length}>New task</button>
            <button className="button primary" onClick={() => setDialog('agent')} disabled={!projects.length}>Spawn agent</button>
          </div>
        </header>

        {error && <div className="error-banner"><strong>Action required</strong><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
        {loading ? <div className="loading">Loading control-plane state…</div> : (
          <>
            {view === 'overview' && <Overview projects={projects} agents={visibleAgents} tasks={visibleTasks} approvals={visibleApprovals} attention={attention} active={active} queued={queued} projectById={projectById} agentById={agentById} onRegister={() => setDialog('project')} onOpenNodes={onOpenNodes} onOpenApprovals={() => setView('approvals')} onOpenAgents={() => setView('agents')} onOpenTasks={() => setView('tasks')} onSpawn={() => setDialog('agent')} />}
            {view === 'projects' && <Projects projects={projects} agents={agents} tasks={tasks} candidates={projectCandidates} onRegister={() => setDialog('project')} onDiscover={() => void mutate(async () => setProjectCandidates(await api.discoverProjects()))} onRegisterCandidate={(candidate) => void mutate(() => api.registerProject({ name: candidate.name, path: candidate.path, defaultBranch: candidate.detectedBranch || 'main' }))} onEnsureSystemAgents={(projectId) => void mutate(() => api.ensureOperationalAgent(projectId))} />}
            {view === 'agents' && <Agents agents={visibleAgents} projectById={projectById} onControlMode={(id, mode) => void mutate(() => api.updateHumanControlMode(id, mode))} onQueueMode={(id, mode) => void mutate(() => api.updateQueueMode(id, mode))} onIntervene={(id) => void mutate(() => api.intervene(id))} />}
            {view === 'tasks' && <Tasks tasks={visibleTasks} projectById={projectById} agentById={agentById} onDispatch={(id) => void mutate(() => api.dispatchTask(id))} onCreate={() => setDialog('task')} />}
            {view === 'messages' && <MessagesView messages={visibleMessages} agents={visibleAgents.length ? visibleAgents : agents} projects={projects} communicationRules={communicationRules} onSend={async (input) => { await mutate(() => api.sendMessage(input)); }} onSaveRule={async (input) => { await mutate(() => api.saveCommunicationRule(input)); }} onDeleteRule={async (id) => { await mutate(() => api.deleteCommunicationRule(id)); }} />}
            {view === 'operations' && <OperationsView projects={projects} agents={agents} projectFilter={projectFilter} />}
            {view === 'approvals' && <ApprovalsView approvals={visibleApprovals} agents={agents} projects={projects} onDecision={async (id, decision) => { await mutate(() => api.decideApproval(id, decision)); }} onAnswer={async (id, answers) => { await mutate(() => api.answerApproval(id, answers)); }} />}
            {view === 'policy' && <PolicyView rules={policyRules} projects={projects} agents={agents} tasks={tasks} onCreate={async (input) => { await mutate(() => api.createPolicyRule(input)); }} onUpdate={async (id, input) => { await mutate(() => api.updatePolicyRule(id, input)); }} onDelete={async (id) => { await mutate(() => api.deletePolicyRule(id)); }} onEvaluate={(input) => api.evaluatePolicy(input)} />}
          </>
        )}
      </main>

      {dialog === 'project' && <ProjectForm onClose={() => setDialog(null)} onSubmit={(input) => mutate(() => api.registerProject(input))} />}
      {dialog === 'agent' && <AgentForm projects={projects} templates={agentTemplates} initialProjectId={projectFilter === 'all' ? projects[0]?.id : projectFilter} onClose={() => setDialog(null)} onSubmit={(input) => mutate(() => api.spawnAgent(input))} />}
      {dialog === 'task' && <TaskForm agents={taskAgents} onClose={() => setDialog(null)} onSubmit={(input) => mutate(() => api.createTask(input))} />}
    </div>
  );
}

function Overview({ projects, agents, tasks, approvals, attention, active, queued, projectById, agentById, onRegister, onOpenNodes, onOpenApprovals, onOpenAgents, onOpenTasks, onSpawn }: {
  projects: Project[]; agents: Agent[]; tasks: Task[]; approvals: HumanApproval[]; attention: number; active: number; queued: number;
  projectById: Map<string, Project>; agentById: Map<string, Agent>; onRegister: () => void; onOpenNodes?: () => void; onOpenApprovals: () => void; onOpenAgents: () => void; onOpenTasks: () => void; onSpawn: () => void;
}) {
  const recent = [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 6);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'PENDING');
  const unhealthyAgents = agents.filter((agent) => ['WAITING_APPROVAL', 'BLOCKED', 'DISCONNECTED', 'FAILED'].includes(agent.status));
  const blockedTasks = tasks.filter((task) => ['WAITING_APPROVAL', 'BLOCKED', 'FAILED'].includes(task.status));
  return <div className="page-stack">
    {!projects.length && <section className="setup-panel" aria-labelledby="setup-title">
      <div><p className="eyebrow">First run</p><h2 id="setup-title">Set up a project workspace</h2><p>Register a Git repository, enroll an execution node, then assign the first agent.</p></div>
      <div className="setup-actions"><button className="button primary" onClick={onRegister}>Register repository</button><button className="button secondary" onClick={onOpenNodes}>Add execution node</button></div>
    </section>}
    {attention > 0 && <section className="attention-panel" aria-labelledby="attention-title">
      <div className="attention-heading"><p className="eyebrow">Operator inbox</p><h2 id="attention-title">Needs attention</h2><p>{attention} item{attention === 1 ? '' : 's'} may need an operator decision or recovery action.</p></div>
      <div className="attention-actions">
        {pendingApprovals.length > 0 && <button className="attention-item" onClick={onOpenApprovals}><strong>{pendingApprovals.length}</strong><span>Pending approval{pendingApprovals.length === 1 ? '' : 's'}</span></button>}
        {unhealthyAgents.length > 0 && <button className="attention-item" onClick={onOpenAgents}><strong>{unhealthyAgents.length}</strong><span>Agent issue{unhealthyAgents.length === 1 ? '' : 's'}</span></button>}
        {blockedTasks.length > 0 && <button className="attention-item" onClick={onOpenTasks}><strong>{blockedTasks.length}</strong><span>Task issue{blockedTasks.length === 1 ? '' : 's'}</span></button>}
      </div>
    </section>}
    <section className="metrics-strip" aria-label="Control plane summary">
      <div><span>Working agents</span><strong>{active}</strong></div>
      <div><span>Queued work</span><strong>{queued}</strong></div>
      <div><span>Registered projects</span><strong>{projects.length}</strong></div>
      <div><span>Needs attention</span><strong>{attention}</strong></div>
    </section>

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Operational state</p><h2>Agents</h2></div>{projects.length ? <button className="button secondary" onClick={onSpawn}>Spawn agent</button> : <button className="button primary" onClick={onRegister}>Register project</button>}</div>
      {!agents.length ? <Empty title="No agents available" body="Register a project and spawn an agent with a bounded responsibility." /> : <div className="data-list">
        {agents.map((agent) => <div className="data-row agent-row" key={agent.id}>
          <div><strong>{agent.name}</strong><small>{projectById.get(agent.projectId)?.name ?? 'Unknown project'} · {label(agent.role)}{agent.systemManaged ? ' · system managed' : ''}</small></div>
          <Status value={agent.status} />
          <p>{agent.responsibility}</p>
          <div className="machine"><code>{agent.branch ?? agent.workingDirectory}</code><small>{agent.humanControlMode === 'IN_THE_LOOP' ? 'Human in loop' : 'Human on loop'}</small></div>
        </div>)}
      </div>}
    </section>

    <section className="panel">
      <div className="section-header"><div><p className="eyebrow">Latest changes</p><h2>Recent tasks</h2></div></div>
      {!recent.length ? <Empty title="No tasks yet" body="Create work for an agent to begin exercising the queue and event bridge." /> : <div className="data-list">
        {recent.map((task) => <div className="data-row task-row" key={task.id}>
          <div><strong>{task.title}</strong><small>{agentById.get(task.assignedAgentId)?.name ?? 'Unknown agent'}</small></div>
          <Status value={task.status} />
          <span className="muted">{projectById.get(task.projectId)?.name}</span>
          <time>{new Date(task.updatedAt).toLocaleString()}</time>
        </div>)}
      </div>}
    </section>
  </div>;
}

function Projects({ projects, agents, tasks, candidates, onRegister, onDiscover, onRegisterCandidate, onEnsureSystemAgents }: { projects: Project[]; agents: Agent[]; tasks: Task[]; candidates: ProjectCandidate[]; onRegister: () => void; onDiscover: () => void; onRegisterCandidate: (candidate: ProjectCandidate) => void; onEnsureSystemAgents: (projectId: string) => void }) {
  return <section className="panel"><div className="section-header"><div><p className="eyebrow">Approved roots</p><h2>Projects</h2></div><div className="form-actions"><button className="button secondary" onClick={onDiscover}>Scan roots</button><button className="button primary" onClick={onRegister}>Register project</button></div></div>
    {!projects.length ? <Empty title="No projects registered" body="Register a repository under an allowed server root." /> : <div className="data-list">
      {projects.map((project) => {
        const projectAgents = agents.filter((agent) => agent.projectId === project.id);
        const ops = projectAgents.find((agent) => agent.role === 'OPERATIONAL');
        const orchestrator = projectAgents.find((agent) => agent.role === 'ORCHESTRATOR');
        const openTasks = tasks.filter((task) => task.projectId === project.id && !['COMPLETED', 'CANCELLED'].includes(task.status));
        const unhealthy = projectAgents.some((agent) => ['FAILED', 'DISCONNECTED', 'BLOCKED'].includes(agent.status));
        return <div className="data-row project-row" key={project.id}>
          <div><strong>{project.name}</strong><code>{project.sourceType === 'GIT' ? project.repositoryUrl : project.rootDirectory}</code></div>
          <span>{project.defaultBranch}</span><span>{projectAgents.length} agents</span><span>{openTasks.length} active tasks</span><span>{ops && orchestrator ? 'System agents ready' : 'System agents pending'}</span><Status value={unhealthy ? 'FAILED' : 'IDLE'} />{(!ops || !orchestrator) && <button className="button compact secondary" onClick={() => onEnsureSystemAgents(project.id)}>Enable system agents</button>}
        </div>;
      })}
    </div>}
    {candidates.length > 0 && <div className="data-list"><div className="section-header"><div><p className="eyebrow">Discovery results</p><h2>Repositories</h2></div></div>{candidates.map((candidate) => <div className="data-row" key={candidate.path}><div><strong>{candidate.name}</strong><code>{candidate.path}</code></div><span>{candidate.detectedBranch || 'main'}</span><span>{candidate.registered ? 'Registered' : 'Unregistered'}</span>{!candidate.registered && <button className="button compact secondary" onClick={() => onRegisterCandidate(candidate)}>Register</button>}</div>)}</div>}
  </section>;
}

function Agents({ agents, projectById, onControlMode, onQueueMode, onIntervene }: {
  agents: Agent[];
  projectById: Map<string, Project>;
  onControlMode: (id: string, mode: HumanControlMode) => void;
  onQueueMode: (id: string, mode: AgentQueueMode) => void;
  onIntervene: (id: string) => void;
}) {
  return <section className="panel"><div className="section-header"><div><p className="eyebrow">Codex threads</p><h2>Agent roster</h2></div></div>
    {!agents.length ? <Empty title="No agents match this scope" body="Spawn an agent from the current project selection." /> : <div className="data-list">
      {agents.map((agent) => <div className="data-row agent-detail-row human-agent-row" key={agent.id}>
        <div><strong>{agent.name}</strong><small>{projectById.get(agent.projectId)?.name} · {label(agent.role)}{agent.systemManaged ? ' · system managed' : ''}</small></div>
        <Status value={agent.status} />
        <p>{agent.responsibility}</p>
        <div className="control-stack"><small>Human control</small><select className="compact-select" value={agent.humanControlMode} onChange={(event) => onControlMode(agent.id, event.target.value as HumanControlMode)}><option value="ON_THE_LOOP">On the loop</option><option value="IN_THE_LOOP">In the loop</option></select></div>
        <div className="control-stack"><small>Queue</small><select className="compact-select" value={agent.queueMode} onChange={(event) => onQueueMode(agent.id, event.target.value as AgentQueueMode)}><option value="AUTO">Automatic</option><option value="REVIEW_BETWEEN_TASKS">Review between tasks</option><option value="PAUSED">Paused</option></select></div>
        <div className="machine"><code>{agent.branch ?? 'shared workspace'}</code><small>{agent.workingDirectory}</small><code title={agent.runtimeSessionId}>{shortId(agent.runtimeSessionId)}</code></div>
        <button className="button compact secondary" onClick={() => onIntervene(agent.id)} disabled={agent.queueMode === 'PAUSED' && !agent.activeTurnId}>Intervene</button>
      </div>)}
    </div>}
  </section>;
}

function Tasks({ tasks, projectById, agentById, onDispatch, onCreate }: { tasks: Task[]; projectById: Map<string, Project>; agentById: Map<string, Agent>; onDispatch: (id: string) => void; onCreate: () => void }) {
  return <section className="panel"><div className="section-header"><div><p className="eyebrow">Durable orchestration</p><h2>Task queue</h2></div><button className="button primary" onClick={onCreate}>New task</button></div>
    {!tasks.length ? <Empty title="No tasks in this scope" body="Create a task and Agenticform will dispatch it according to the agent queue policy." /> : <div className="data-list">
      {tasks.map((task) => <div className="data-row task-detail-row" key={task.id}>
        <div><strong>{task.title}</strong><small>{projectById.get(task.projectId)?.name} / {agentById.get(task.assignedAgentId)?.name}</small></div><Status value={task.status} /><span>Priority {task.priority}</span><div className="machine"><code>queue {shortId(task.queuedSubmissionId)}</code><code>turn {shortId(task.turnId)}</code></div>{task.report ? <details><summary>Task report</summary><p>{task.report}</p></details> : task.lastError ? <span className="inline-error" title={task.lastError}>Reconcile issue</span> : <span className="muted">Awaiting report</span>}<button className="button compact secondary" disabled={!['READY', 'BLOCKED'].includes(task.status)} onClick={() => onDispatch(task.id)}>Dispatch</button>
      </div>)}
    </div>}
  </section>;
}

function Empty({ title, body }: { title: string; body: string }) { return <div className="empty"><strong>{title}</strong><p>{body}</p></div>; }

function ProjectForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: { name: string; sourceType: 'LOCAL_PATH' | 'GIT'; path?: string; repositoryUrl?: string; defaultBranch: string }) => void }) {
  const [sourceType, setSourceType] = useState<'LOCAL_PATH' | 'GIT'>('GIT');
  const [name, setName] = useState(''); const [path, setPath] = useState('/srv/apps/'); const [repositoryUrl, setRepositoryUrl] = useState(''); const [branch, setBranch] = useState('main');
  return <Modal title="Register project" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit(sourceType === 'GIT' ? { name, sourceType, repositoryUrl, defaultBranch: branch } : { name, sourceType, path, defaultBranch: branch }); }}>
    <label>Source<select value={sourceType} onChange={(event) => setSourceType(event.target.value as 'LOCAL_PATH' | 'GIT')}><option value="GIT">Git repository</option><option value="LOCAL_PATH">Server directory</option></select></label>
    <label>Project name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="My project" /></label>
    {sourceType === 'GIT' ? <label>Repository URL<input required type="url" className="mono" value={repositoryUrl} onChange={(e) => setRepositoryUrl(e.target.value)} placeholder="https://github.com/org/repository.git" /><small>Use a credential-free HTTPS URL. Agents clone this repository on the selected node.</small></label> : <label>Server directory<input required className="mono" value={path} onChange={(e) => setPath(e.target.value)} /><small>The backend validates this path against configured project roots.</small></label>}
    <label>Default branch<input required className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" /></label>
    <footer className="form-actions"><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary">Register project</button></footer>
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
