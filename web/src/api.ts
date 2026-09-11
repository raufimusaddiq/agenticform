import type {
  Agent,
  AgentMessage,
  AgentMessageType,
  AgentQueueMode,
  HumanApproval,
  HumanApprovalDecision,
  HumanControlMode,
  PolicyDecision,
  PolicyEffect,
  PolicyRule,
  PolicyScopeType,
  Project,
  Task,
  WorkspaceMode
} from './types';

const base = import.meta.env.VITE_API_BASE_URL ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
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

export const api = {
  projects: () => request<Project[]>('/api/projects'),
  agents: () => request<Agent[]>('/api/agents'),
  tasks: () => request<Task[]>('/api/tasks'),
  messages: () => request<AgentMessage[]>('/api/messages'),
  approvals: () => request<HumanApproval[]>('/api/approvals'),
  policyRules: () => request<PolicyRule[]>('/api/policies/rules'),

  registerProject: (input: { name: string; path: string; defaultBranch: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),

  spawnAgent: (input: {
    projectId: string;
    name: string;
    responsibility: string;
    workspaceMode: WorkspaceMode;
    baseBranch?: string;
    branch?: string;
    queueMode: AgentQueueMode;
    humanControlMode: HumanControlMode;
  }) => request<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(input) }),

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

  createTask: (input: { agentId: string; title: string; prompt: string; priority: number }) =>
    request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),

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
  }) => request<PolicyDecision>('/api/policies/evaluate', { method: 'POST', body: JSON.stringify(input) })
};
