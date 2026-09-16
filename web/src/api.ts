import { getAdminToken } from './auth';
import type { ExecutionNode, ExecutionNodeStatus, NodeEnrollment, NodeTrustLevel } from './nodeTypes';
import type {
  Agent,
  AgentCapabilityProfile,
  AgentTemplate,
  AgentMessage,
  AgentMessageType,
  AgentQueueMode,
  HumanApproval,
  HumanApprovalDecision,
  HumanControlMode,
  OperationRun,
  OperationRunDetail,
  OperationalEnvironment,
  OperationalEnvironmentKind,
  OperationalRunbook,
  OperationalService,
  PolicyDecision,
  PolicyEffect,
  PolicyRule,
  PolicyScopeType,
  Project,
  RunbookStep,
  Task,
  WorkspaceCleanupInspection,
  WorkspaceCleanupRecord,
  WorkspaceMode,
  CommunicationRule,
  RuntimeType
} from './types';

const base = import.meta.env.VITE_API_BASE_URL ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) throw new Error('ADMIN_AUTH_REQUIRED');
    throw new Error(body || `${response.status} ${response.statusText}`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type PolicyRuleInput = {
  scopeType: PolicyScopeType;
  scopeId?: string | null;
  action: string;
  environment?: string;
  effect: PolicyEffect;
  description?: string;
  enabled: boolean;
};

export type EnvironmentInput = {
  projectId: string;
  key: string;
  displayName: string;
  kind: OperationalEnvironmentKind;
};

export type ServiceInput = {
  projectId: string;
  environmentId: string;
  key: string;
  displayName: string;
  healthUrl?: string;
  readinessUrl?: string;
};

export type RunbookInput = {
  projectId: string;
  environmentId: string;
  key: string;
  name: string;
  action: string;
  description: string;
  steps: RunbookStep[];
};

export type OperationExternalWait = {
  id: string;
  operationRunId: string;
  stepRunId: string;
  provider: string;
  mode: 'WAIT' | 'DISPATCH';
  repository: string;
  workflow: string;
  ref: string;
  expectedHeadSha: string;
  externalRunId: number | null;
  externalUrl: string | null;
  correlationNotBefore: string | null;
  deadline: string;
  status: 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
  lastObservedStatus: string | null;
  lastObservedConclusion: string | null;
  createdAt: string;
  updatedAt: string;
};

export const api = {
  projects: () => request<Project[]>('/api/projects'),
  discoverProjects: () => request<Array<{ name: string; path: string; configuredRoot: string; detectedBranch: string | null; registered: boolean }>>('/api/projects/discover'),
  agents: () => request<Agent[]>('/api/agents'),
  agentTemplates: () => request<AgentTemplate[]>('/api/agents/templates'),
  tasks: () => request<Task[]>('/api/tasks'),
  messages: () => request<AgentMessage[]>('/api/messages'),
  approvals: () => request<HumanApproval[]>('/api/approvals'),
  policyRules: () => request<PolicyRule[]>('/api/policies/rules'),
  executionNodes: () => request<ExecutionNode[]>('/api/nodes'),
  operationalEnvironments: () => request<OperationalEnvironment[]>('/api/operations/environments'),
  operationalServices: () => request<OperationalService[]>('/api/operations/services'),
  operationalRunbooks: () => request<OperationalRunbook[]>('/api/operations/runbooks'),
  operationRuns: () => request<OperationRun[]>('/api/operations/runs'),
  operationRun: (runId: string) => request<OperationRunDetail>(`/api/operations/runs/${runId}`),
  operationExternalWaits: (runId: string) => request<OperationExternalWait[]>(`/api/operations/runs/${runId}/external-waits`),
  workspaceCleanupHistory: (projectId?: string) => request<WorkspaceCleanupRecord[]>(
    `/api/workspaces/cleanup-history${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  workspaceCleanupInspection: (agentId: string) =>
    request<WorkspaceCleanupInspection>(`/api/workspaces/agents/${agentId}/cleanup-inspection`),

  registerProject: (input: {
    name: string;
    sourceType?: 'LOCAL_PATH' | 'GIT';
    path?: string;
    repositoryUrl?: string;
    defaultBranch: string;
    githubToken?: string;
  }) => request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),

  updateProject: (projectId: string, input: { name: string; defaultBranch: string; enabled: boolean; githubToken?: string }) =>
    request<Project>(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(input) }),

  spawnAgent: (input: {
    projectId: string;
    name: string;
    responsibility: string;
    runtimeType: RuntimeType;
    runtimeProfileId?: string;
    workspaceMode: WorkspaceMode;
    baseBranch?: string;
    branch?: string;
    queueMode: AgentQueueMode;
    humanControlMode: HumanControlMode;
    executionNodeId?: string;
    minimumTrust?: NodeTrustLevel;
    capabilityProfile?: AgentCapabilityProfile;
    templateId?: string;
  }) => request<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(input) }),

  createNodeEnrollment: (name: string, trustLevel: NodeTrustLevel) =>
    request<NodeEnrollment>('/api/nodes/enrollments', {
      method: 'POST',
      body: JSON.stringify({ name, trustLevel })
    }),

  updateNodeStatus: (nodeId: string, status: ExecutionNodeStatus) =>
    request<ExecutionNode>(`/api/nodes/${nodeId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status })
    }),

  ensureOperationalAgent: (projectId: string) =>
    request<Agent>('/api/agents/operational/ensure', {
      method: 'POST',
      body: JSON.stringify({ projectId })
    }),

  updateHumanControlMode: (agentId: string, mode: HumanControlMode) =>
    request<Agent>(`/api/agents/${agentId}/human-control-mode`, {
      method: 'POST',
      body: JSON.stringify({ mode })
    }),

  updateQueueMode: (agentId: string, mode: AgentQueueMode) =>
    request<Agent>(`/api/agents/${agentId}/queue-mode`, {
      method: 'POST',
      body: JSON.stringify({ mode })
    }),

  intervene: (agentId: string) =>
    request<Agent>(`/api/agents/${agentId}/intervene`, { method: 'POST' }),

  restartRuntime: (agentId: string) =>
    request<Agent>(`/api/agents/${agentId}/restart-runtime`, { method: 'POST' }),

  cleanupWorkspace: (agentId: string, reason = 'Operator requested cleanup') =>
    request<WorkspaceCleanupRecord>(`/api/workspaces/agents/${agentId}/cleanup`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }),

  createTask: (input: {
    agentId: string; title: string; prompt: string; priority: number;
    kind?: string; deliverable?: string; deploymentRequired?: boolean; environmentKey?: string;
  }) => request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),

  dispatchTask: (taskId: string) =>
    request<Task>(`/api/tasks/${taskId}/dispatch`, { method: 'POST' }),

  sendMessage: (input: {
    fromAgentId: string;
    toAgentId: string;
    type: AgentMessageType;
    subject: string;
    content: string;
    replyToMessageId?: string;
  }) => request<AgentMessage>('/api/messages', { method: 'POST', body: JSON.stringify(input) }),

  communicationRules: () => request<CommunicationRule[]>('/api/communication-rules'),
  saveCommunicationRule: (input: { fromProjectId: string; toProjectId: string; effect: 'ALLOW' | 'DENY'; enabled: boolean }) =>
    request<CommunicationRule>('/api/communication-rules', { method: 'PUT', body: JSON.stringify({ ...input, action: 'MESSAGE' }) }),
  deleteCommunicationRule: (id: string) => request<void>(`/api/communication-rules/${id}`, { method: 'DELETE' }),

  decideApproval: (approvalId: string, decision: HumanApprovalDecision) =>
    request<HumanApproval>(`/api/approvals/${approvalId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision })
    }),

  answerApproval: (approvalId: string, answers: Record<string, string[]>) =>
    request<HumanApproval>(`/api/approvals/${approvalId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answers })
    }),

  createPolicyRule: (input: PolicyRuleInput) =>
    request<PolicyRule>('/api/policies/rules', { method: 'POST', body: JSON.stringify(input) }),

  updatePolicyRule: (ruleId: string, input: PolicyRuleInput) =>
    request<PolicyRule>(`/api/policies/rules/${ruleId}`, { method: 'PUT', body: JSON.stringify(input) }),

  deletePolicyRule: (ruleId: string) =>
    request<void>(`/api/policies/rules/${ruleId}`, { method: 'DELETE' }),

  evaluatePolicy: (input: {
    projectId?: string | null;
    agentId?: string | null;
    taskId?: string | null;
    action: string;
    environment?: string;
  }) => request<PolicyDecision>('/api/policies/evaluate', { method: 'POST', body: JSON.stringify(input) }),

  createOperationalEnvironment: (input: EnvironmentInput) =>
    request<OperationalEnvironment>('/api/operations/environments', { method: 'POST', body: JSON.stringify(input) }),

  createOperationalService: (input: ServiceInput) =>
    request<OperationalService>('/api/operations/services', { method: 'POST', body: JSON.stringify(input) }),

  createOperationalRunbook: (input: RunbookInput) =>
    request<OperationalRunbook>('/api/operations/runbooks', { method: 'POST', body: JSON.stringify(input) }),

  startOperation: (runbookId: string, input: {
    agentId?: string | null;
    taskId?: string | null;
    requestedBy?: string;
    parameters?: Record<string, string>;
  }) => request<OperationRun>(`/api/operations/runbooks/${runbookId}/runs`, {
    method: 'POST',
    body: JSON.stringify(input)
  }),

  approveOperation: (runId: string, actor = 'operator') =>
    request<OperationRun>(`/api/operations/runs/${runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ actor })
    }),

  declineOperation: (runId: string, actor = 'operator', reason = 'Operator declined operation') =>
    request<OperationRun>(`/api/operations/runs/${runId}/decline`, {
      method: 'POST',
      body: JSON.stringify({ actor, reason })
    })
};
