export type ProjectSourceType = 'LOCAL_PATH' | 'GIT';

export type Project = {
  id: string;
  name: string;
  slug: string;
  sourceType: ProjectSourceType;
  rootDirectory: string | null;
  repositoryUrl: string | null;
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
  | 'STOPPING'
  | 'STOPPED';

export type AgentQueueMode = 'AUTO' | 'REVIEW_BETWEEN_TASKS' | 'PAUSED';
export type WorkspaceMode = 'ISOLATED_WORKTREE' | 'SHARED_PROJECT';
export type HumanControlMode = 'IN_THE_LOOP' | 'ON_THE_LOOP';
export type AgentRole = 'GENERAL' | 'OPERATIONAL';

export type Agent = {
  id: string;
  projectId: string;
  name: string;
  responsibility: string;
  codexThreadId: string;
  workspaceMode: WorkspaceMode;
  sourceDirectory: string | null;
  workingDirectory: string | null;
  branch: string | null;
  status: AgentStatus;
  queueMode: AgentQueueMode;
  humanControlMode: HumanControlMode;
  role: AgentRole;
  systemManaged: boolean;
  executionNodeId: string | null;
  activeTaskId: string | null;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskStatus =
  | 'QUEUED'
  | 'READY'
  | 'WAITING_DEPENDENCY'
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

export type AgentMessageStatus = 'CREATED' | 'QUEUED' | 'DISPATCHED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export type AgentMessage = {
  id: string;
  projectId: string;
  fromAgentId: string;
  toAgentId: string | null;
  conversationId: string;
  replyToMessageId: string | null;
  type: AgentMessageType;
  audienceType: 'DIRECT' | 'MULTICAST' | 'ROLE' | 'GROUP' | 'PROJECT_BROADCAST';
  audienceSpecJson: string;
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

export type HumanApprovalStatus =
  | 'PENDING'
  | 'AUTO_APPROVED'
  | 'PREAUTHORIZED'
  | 'POLICY_DENIED'
  | 'APPROVED'
  | 'APPROVED_FOR_SESSION'
  | 'DECLINED'
  | 'CANCELLED'
  | 'ANSWERED'
  | 'FAILED'
  | 'ORPHANED';
export type HumanApprovalDecision = 'APPROVE_ONCE' | 'APPROVE_SESSION' | 'DECLINE' | 'CANCEL';
export type HumanApprovalType = 'COMMAND_EXECUTION' | 'FILE_CHANGE' | 'PERMISSIONS' | 'USER_INPUT' | 'PROTECTED_ACTION';
export type HumanApprovalRisk = 'LOW' | 'ELEVATED' | 'HIGH';

export type HumanApproval = {
  id: string;
  projectId: string;
  agentId: string;
  codexRequestId: string;
  method: string;
  type: HumanApprovalType;
  controlMode: HumanControlMode;
  risk: HumanApprovalRisk;
  status: HumanApprovalStatus;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  summary: string;
  policyAction: string | null;
  policyEnvironment: string | null;
  policyEffect: PolicyEffect | null;
  policyRuleId: string | null;
  preauthorizationGrantId: string | null;
  requestPayload: string;
  responsePayload: string | null;
  lastError: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type PolicyScopeType = 'GLOBAL' | 'PROJECT' | 'AGENT' | 'TASK';
export type PolicyEffect = 'ALLOW' | 'REQUIRE_HUMAN' | 'DENY';

export type PolicyRule = {
  id: string;
  scopeType: PolicyScopeType;
  scopeId: string | null;
  action: string;
  environment: string;
  effect: PolicyEffect;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PolicyDecision = {
  effect: PolicyEffect;
  matchedRuleId: string | null;
  matchedScopeType: PolicyScopeType | null;
  matchedScopeId: string | null;
  action: string;
  environment: string;
  description: string;
};

export type OperationalEnvironmentKind = 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
export type OperationalEnvironment = {
  id: string;
  projectId: string;
  key: string;
  displayName: string;
  kind: OperationalEnvironmentKind;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OperationalService = {
  id: string;
  projectId: string;
  environmentId: string;
  key: string;
  displayName: string;
  healthUrl: string | null;
  readinessUrl: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RunbookStep = {
  key: string;
  name: string;
  type: string;
  parameters?: Record<string, string>;
  timeoutSeconds?: number;
  continueOnFailure?: boolean;
};

export type OperationalRunbook = {
  id: string;
  projectId: string;
  environmentId: string;
  key: string;
  name: string;
  version: number;
  action: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OperationRunStatus = 'PENDING_APPROVAL' | 'QUEUED' | 'RUNNING' | 'WAITING_EXTERNAL' | 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'CANCELLED';
export type OperationStepStatus = 'PENDING' | 'RUNNING' | 'WAITING_EXTERNAL' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export type OperationRun = {
  id: string;
  projectId: string;
  runbookId: string;
  runbookVersion: number;
  environmentId: string;
  environmentKey: string;
  action: string;
  status: OperationRunStatus;
  policyEffect: PolicyEffect;
  policyRuleId: string | null;
  requestedBy: string;
  requestedByAgentId: string | null;
  taskId: string | null;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type OperationStepRun = {
  id: string;
  operationRunId: string;
  stepKey: string;
  stepName: string;
  stepType: string;
  ordinal: number;
  status: OperationStepStatus;
  summary: string | null;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type OperationEvent = {
  id: string;
  operationRunId: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  detail: string | null;
  createdAt: string;
};

export type OperationRunDetail = {
  run: OperationRun;
  steps: OperationStepRun[];
  events: OperationEvent[];
};

export type WorkspaceCleanupRecord = {
  id: string;
  projectId: string;
  agentId: string;
  workingDirectory: string;
  branch: string | null;
  outcome: string;
  reason: string;
  freedBytes: number;
  createdAt: string;
};

export type WorkspaceCleanupInspection = {
  agentId: string;
  eligible: boolean;
  reason: string;
  estimatedBytes: number;
};
