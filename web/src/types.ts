export type Project = {
  id: string;
  name: string;
  slug: string;
  rootDirectory: string;
  defaultBranch: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AgentStatus =
  | 'STARTING'
  | 'IDLE'
  | 'WORKING'
  | 'WAITING_APPROVAL'
  | 'BLOCKED'
  | 'DISCONNECTED'
  | 'FAILED'
  | 'STOPPED';

export type AgentQueueMode = 'AUTO' | 'REVIEW_BETWEEN_TASKS' | 'PAUSED';
export type WorkspaceMode = 'ISOLATED_WORKTREE' | 'SHARED_PROJECT';

export type Agent = {
  id: string;
  projectId: string;
  name: string;
  responsibility: string;
  codexThreadId: string;
  workspaceMode: WorkspaceMode;
  sourceDirectory: string;
  workingDirectory: string;
  branch: string | null;
  status: AgentStatus;
  queueMode: AgentQueueMode;
  activeTaskId: string | null;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskStatus =
  | 'QUEUED'
  | 'READY'
  | 'DISPATCHING'
  | 'DISPATCHED'
  | 'RUNNING'
  | 'BLOCKED'
  | 'WAITING_APPROVAL'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type Task = {
  id: string;
  projectId: string;
  assignedAgentId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: number;
  codexQueuedSubmissionId: string | null;
  codexTurnId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentMessageType =
  | 'QUESTION'
  | 'ANSWER'
  | 'REQUEST'
  | 'RESULT'
  | 'HANDOFF'
  | 'REVIEW_REQUEST'
  | 'REVIEW_RESULT'
  | 'INFORMATION'
  | 'BLOCKER';

export type AgentMessageStatus = 'CREATED' | 'DISPATCHED' | 'FAILED';

export type AgentMessage = {
  id: string;
  projectId: string;
  fromAgentId: string;
  toAgentId: string;
  conversationId: string;
  replyToMessageId: string | null;
  type: AgentMessageType;
  subject: string;
  content: string;
  hopCount: number;
  status: AgentMessageStatus;
  codexQueuedSubmissionId: string | null;
  codexTurnId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
