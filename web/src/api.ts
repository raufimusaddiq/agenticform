import type { Agent, AgentMessage, AgentMessageType, AgentQueueMode, Project, Task, WorkspaceMode } from './types';

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

export const api = {
  projects: () => request<Project[]>('/api/projects'),
  agents: () => request<Agent[]>('/api/agents'),
  tasks: () => request<Task[]>('/api/tasks'),
  messages: () => request<AgentMessage[]>('/api/messages'),

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
  }) => request<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(input) }),

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
  }) => request<AgentMessage>('/api/messages', { method: 'POST', body: JSON.stringify(input) })
};
