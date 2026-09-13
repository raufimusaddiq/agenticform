import { FormEvent, useEffect, useState } from 'react';
import App from './App';
import { api } from './api';
import { clearAdminToken, getAdminToken, setAdminToken } from './auth';
import type { ExecutionNode, ExecutionNodeStatus, NodeEnrollment, NodeTrustLevel } from './nodeTypes';
import { LoadingState, Status } from './ui';
import './nodes.css';

const trustLevels: NodeTrustLevel[] = ['UNTRUSTED', 'STANDARD', 'TRUSTED', 'PRIVILEGED'];

type RuntimeReadiness = { available?: boolean; authenticated?: boolean; version?: string };

function runtimeReadiness(node: ExecutionNode, runtime: string): RuntimeReadiness {
  try {
    const capabilities = JSON.parse(node.capabilitiesJson) as { runtimes?: Record<string, RuntimeReadiness> };
    return capabilities.runtimes?.[runtime] ?? {};
  } catch {
    return {};
  }
}

export function SecureShell() {
  const [authenticated, setAuthenticated] = useState(Boolean(getAdminToken()));
  const [loginError, setLoginError] = useState<string | null>(null);
  const [nodesOpen, setNodesOpen] = useState(false);

  async function login(token: string) {
    setAdminToken(token);
    try {
      await api.projects();
      setAuthenticated(true);
      setLoginError(null);
    } catch {
      clearAdminToken();
      setLoginError('Invalid admin token or control plane is unavailable.');
    }
  }

  function logout() {
    clearAdminToken();
    setAuthenticated(false);
    setNodesOpen(false);
  }

  if (!authenticated) return <Login onLogin={login} error={loginError} />;

  return <>
    <App onOpenNodes={() => setNodesOpen(true)} />
    <div className="secure-shell-actions"><button className="button ghost" type="button" onClick={logout}>Sign out</button></div>
    {nodesOpen && <NodesPanel onClose={() => setNodesOpen(false)} />}
  </>;
}

function Login({ onLogin, error }: { onLogin: (token: string) => Promise<void>; error: string | null }) {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    setSubmitting(true);
    try { await onLogin(token.trim()); }
    finally { setSubmitting(false); }
  }

  return <main className="auth-page">
    <section className="auth-card">
      <p className="eyebrow">Agenticform</p>
      <h1>Control plane access</h1>
      <p className="muted">Enter the admin token configured in <code>AGENTICFORM_ADMIN_TOKEN</code>. It is kept only for this browser session.</p>
      <form onSubmit={submit} className="auth-form">
        <label>Admin token<input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} autoFocus /></label>
        {error && <div className="error-banner"><span>{error}</span></div>}
        <button className="button primary" disabled={submitting || !token.trim()}>{submitting ? 'Verifying…' : 'Unlock control plane'}</button>
      </form>
    </section>
  </main>;
}

function NodesPanel({ onClose }: { onClose: () => void }) {
  const [nodes, setNodes] = useState<ExecutionNode[]>([]);
  const [name, setName] = useState('');
  const [trust, setTrust] = useState<NodeTrustLevel>('STANDARD');
  const [enrollment, setEnrollment] = useState<NodeEnrollment | null>(null);
  const [projectName, setProjectName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [projectCreated, setProjectCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmation, setConfirmation] = useState<{ node: ExecutionNode; status: ExecutionNodeStatus } | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);

  async function refresh() {
    try {
      setNodes(await api.executionNodes());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load execution nodes');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  async function createEnrollment(event: FormEvent) {
    event.preventDefault();
    try {
      const next = await api.createNodeEnrollment(name.trim(), trust);
      setEnrollment(next);
      setName('');
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create enrollment');
    }
  }

  async function registerGitProject(event: FormEvent) {
    event.preventDefault();
    try {
      const project = await api.registerProject({
        name: projectName.trim(), sourceType: 'GIT', repositoryUrl: repositoryUrl.trim(), defaultBranch: defaultBranch.trim()
      });
      setProjectCreated(project.name);
      setProjectName('');
      setRepositoryUrl('');
      setDefaultBranch('main');
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to register distributed project');
    }
  }

  async function status(nodeId: string, next: ExecutionNodeStatus) {
    try {
      await api.updateNodeStatus(nodeId, next);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update node');
    }
  }

  return <div className="node-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="node-panel" role="dialog" aria-modal="true" aria-label="Execution nodes" onMouseDown={(event) => event.stopPropagation()}>
      <header className="node-panel-header">
        <div><h2>Execution nodes</h2></div>
        <div className="top-actions"><button className="button primary" onClick={() => setEnrollOpen(true)}>Enroll node</button><button className="button ghost" onClick={onClose}>Close</button></div>
      </header>

      {error && <div className="error-banner"><span>{error}</span></div>}

      {enrollOpen && <div className="confirm-backdrop" role="presentation"><section className="confirm-dialog node-enrollment" role="dialog" aria-modal="true" aria-label="Enroll execution node">
        <div><h3>Add execution node</h3><p className="muted">Generate a single-use setup command. Nodes connect outbound over HTTPS; no inbound worker port is required.</p></div>
        <form onSubmit={createEnrollment} className="node-enroll-form">
          <input placeholder="home-server" value={name} onChange={(event) => setName(event.target.value)} required />
          <select value={trust} onChange={(event) => setTrust(event.target.value as NodeTrustLevel)}>{trustLevels.map((value) => <option key={value}>{value}</option>)}</select>
          <button className="button primary">Generate setup command</button>
        </form>
        <button className="button ghost" type="button" onClick={() => setEnrollOpen(false)}>Close</button>
      </section></div>}

      {enrollment && <section className="setup-command-card">
        <div className="section-header"><div><p className="eyebrow">Single-use</p><h3>Run this on the new node</h3></div><button className="button ghost" onClick={() => setEnrollment(null)}>Hide</button></div>
        <pre>{enrollment.setupCommand}</pre>
        <div className="setup-meta"><span>Expires {new Date(enrollment.expiresAt).toLocaleString()}</span><button className="button secondary" onClick={() => void navigator.clipboard.writeText(enrollment.setupCommand)}>Copy command</button></div>
        <p className="muted">The bootstrap token is consumed once. The permanent daemon keeps only its local Ed25519 device identity.</p>
      </section>}

      <details className="secondary-section">
        <summary>Register distributed Git project</summary>
        <div><h3>Register distributed GIT project</h3><p className="muted">Use a credential-free HTTPS repository URL. Agents for this project are automatically placed on eligible execution nodes.</p></div>
        <form onSubmit={registerGitProject} className="distributed-project-form">
          <input placeholder="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} required />
          <input className="mono" type="url" placeholder="https://github.com/org/repo.git" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} required />
          <input className="mono" placeholder="main" value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} required />
          <button className="button secondary">Register GIT project</button>
        </form>
        {projectCreated && <p className="form-note">{projectCreated} registered. The main project list will refresh automatically.</p>}
      </details>

      <section className="node-list">
        <div className="section-header"><h3>Fleet</h3><button className="button ghost" onClick={() => void refresh()}>Refresh</button></div>
        {loading ? <LoadingState label="Loading execution nodes" /> : !nodes.length ? <div className="empty-state">No execution nodes enrolled.</div> : <div className="node-workbench"><div className="workbench-table node-table"><div className="table-head"><span>Node</span><span>State</span><span>Runtime</span><span>Capacity</span><span>Last seen</span></div>{nodes.map((node) => {
          const codex = runtimeReadiness(node, 'CODEX');
          const runtimeMessage = node.status !== 'ONLINE' ? `Node ${node.status.toLowerCase()}`
            : !codex.available ? 'Codex runtime missing'
              : !codex.authenticated ? 'Codex authentication required'
                : node.protocolCompatible === false ? 'Node protocol incompatible' : 'Ready';
          return <button className={`table-row${(selectedNodeId ?? nodes[0]?.id) === node.id ? ' selected' : ''}`} key={node.id} onClick={() => setSelectedNodeId(node.id)}><span>{node.name}</span><Status value={node.status} /><span>{runtimeMessage}</span><span>{node.maxAgents} agents</span><time>{node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : '-'}</time></button>;
        })}</div><aside className="inspector">{(() => { const node = nodes.find((item) => item.id === (selectedNodeId ?? nodes[0]?.id)); if (!node) return null; const codex = runtimeReadiness(node, 'CODEX'); return <><h3>{node.name}</h3><Status value={node.status} /><dl><dt>Host</dt><dd>{node.hostname ?? '-'}</dd><dt>OS</dt><dd>{node.os ?? '-'}</dd><dt>Architecture</dt><dd>{node.arch ?? '-'}</dd><dt>Runtime</dt><dd>{codex.available ? `Codex ${codex.version ?? 'installed'}` : 'Unavailable'}</dd><dt>Authentication</dt><dd>{codex.authenticated ? 'Ready' : 'Required'}</dd><dt>Protocol</dt><dd>{node.nodeVersion ?? '-'}</dd><dt>Capacity</dt><dd>{node.maxAgents} agents</dd><dt>Disk free</dt><dd>{node.diskFreeMb == null ? '-' : `${Math.round(node.diskFreeMb / 1024)} GB`}</dd><dt>Trust</dt><dd>{node.trustLevel}</dd><dt>Fingerprint</dt><dd><code>{node.fingerprint}</code></dd></dl><div className="node-actions">{node.status === 'ONLINE' && <button className="button secondary" onClick={() => void status(node.id, 'DRAINING')}>Drain</button>}{node.status === 'DRAINING' && <button className="button secondary" onClick={() => void status(node.id, 'ONLINE')}>Resume</button>}{node.status !== 'DISABLED' && node.status !== 'REVOKED' && <button className="button ghost" onClick={() => setConfirmation({ node, status: 'DISABLED' })}>Disable</button>}{node.status === 'DISABLED' && <button className="button secondary" onClick={() => void status(node.id, 'OFFLINE')}>Enable</button>}{node.status !== 'REVOKED' && <button className="button danger" onClick={() => setConfirmation({ node, status: 'REVOKED' })}>Revoke</button>}</div></>; })()}</aside></div>}
      </section>
      {confirmation && <div className="confirm-backdrop" role="presentation" onMouseDown={() => setConfirmation(null)}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.stopPropagation()}><h3 id="confirm-title">{confirmation.status === 'REVOKED' ? 'Revoke node?' : 'Disable node?'}</h3><p>{confirmation.node.name} will be {confirmation.status === 'REVOKED' ? 'permanently revoked' : 'removed from scheduling'}. Existing work will not be restarted.</p><div className="form-actions"><button className="button ghost" onClick={() => setConfirmation(null)}>Cancel</button><button className={confirmation.status === 'REVOKED' ? 'button danger' : 'button secondary'} onClick={() => { const item = confirmation; setConfirmation(null); void status(item.node.id, item.status); }}>{confirmation.status === 'REVOKED' ? 'Revoke node' : 'Disable node'}</button></div></section></div>}
    </section>
  </div>;
}
