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
export type AgentRole = 'GENERAL' | 'ORCHESTRATOR' | 'OPERATIONAL';
export type AgentCapabilityProfile = 'IMPLEMENTER' | 'REVIEWER' | 'ARCHITECT' | 'ORCHESTRATOR' | 'OPS';
export type RuntimeType = 'CODEX';
export type AgentTemplate = { id: string; displayName: string; responsibility: string; capabilityProfile: AgentCapabilityProfile; specialty: string };

export type Agent = {
  id: string;
  projectId: string;
  name: string;
  responsibility: string;
  runtimeType: RuntimeType;
  runtimeProfileId: string | null;
  runtimeSessionId: string;
  workspaceMode: WorkspaceMode;
  sourceDirectory: string | null;
  workingDirectory: string | null;
  branch: string | null;
  status: AgentStatus;
  queueMode: AgentQueueMode;
  humanControlMode: HumanControlMode;
  role: AgentRole;
  capabilityProfile: AgentCapabilityProfile;
  specialty: string | null;
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
export type TaskKind = 'GENERAL' | 'ORCHESTRATION' | 'ARCHITECTURE' | 'IMPLEMENTATION' | 'REVIEW' | 'TEST' | 'OPERATIONS';

export type Task = {
  id: string;
  projectId: string;
  assignedAgentId: string;
  parentTaskId: string | null;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: number;
  kind: TaskKind;
  queuedSubmissionId: string | null;
  turnId: string | null;
  lastError: string | null;
  report: string | null;
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
export type AgentMessageAudienceType = 'DIRECT' | 'MULTICAST' | 'ROLE' | 'GROUP' | 'PROJECT_BROADCAST';

export type AgentMessage = {
  id: string;
  projectId: string;
  fromAgentId: string;
  toAgentId: string | null;
  audienceType: AgentMessageAudienceType;
  audienceSpec: string | null;
  conversationId: string;
  replyToMessageId: string | null;
  type: AgentMessageType;
  subject: string;
  content: string;
  hopCount: number;
  status: AgentMessageStatus;
  queuedSubmissionId: string | null;
  turnId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CommunicationRule = {
  id: string;
  fromProjectId: string;
  toProjectId: string;
  action: 'MESSAGE';
  effect: 'ALLOW' | 'DENY';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HumanApprovalType = 'COMMAND_EXECUTION' | 'FILE_CHANGE' | 'PERMISSIONS' | 'USER_INPUT' | 'PROTECTED_ACTION';
export type HumanApprovalRisk = 'LOW' | 'ELEVATED' | 'HIGH';
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
  matchedRuleId: string;
  matchedScopeType: PolicyScopeType;
  matchedScopeId: string | null;
  action: string;
  environment: string;
  description: string;
};

export type HumanApproval = {
  id: string;
  projectId: string;
  agentId: string;
  runtimeRequestId: string;
  method: string;
  type: HumanApprovalType;
  controlMode: HumanControlMode;
  risk: HumanApprovalRisk;
  status: HumanApprovalStatus;
  runtimeSessionId: string;
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

export type OperationalEnvironmentKind = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION' | 'OTHER';

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

export type RunbookStepType = 'ASSERT_GIT_CLEAN' | 'ASSERT_GIT_SHA' | 'COMMAND' | 'HTTP_CHECK' | 'SERVICE_CHECK' | 'GITHUB_WORKFLOW';

export type RunbookStep = {
  key: string;
  name: string;
  type: RunbookStepType;
  config: Record<string, unknown>;
  timeoutSeconds: number;
};

export type OperationalRunbook = {
  id: string;
  projectId: string;
  environmentId: string;
  environmentKey: string;
  key: string;
  name: string;
  action: string;
  description: string;
  enabled: boolean;
  version: number;
  steps: RunbookStep[];
  createdAt: string;
  updatedAt: string;
};

export type OperationRunStatus =
  | 'WAITING_APPROVAL'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_EXTERNAL'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DENIED'
  | 'DECLINED'
  | 'INTERRUPTED';

export type OperationRun = {
  id: string;
  projectId: string;
  runbookId: string;
  environmentId: string;
  requestedAgentId: string | null;
  requestedTaskId: string | null;
  requestedBy: string;
  action: string;
  environmentKey: string;
  status: OperationRunStatus;
  policyEffect: PolicyEffect;
  policyRuleId: string | null;
  runbookSnapshot: string;
  parametersJson: string;
  approvedBy: string | null;
  lastError: string | null;
  createdAt: string;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type OperationStepRun = {
  id: string;
  operationRunId: string;
  stepKey: string;
  stepName: string;
  stepType: RunbookStepType;
  position: number;
  status: 'RUNNING' | 'WAITING_EXTERNAL' | 'SUCCEEDED' | 'FAILED';
  summary: string | null;
  evidence: string | null;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string;
  completedAt: string | null;
};

export type OperationRunDetail = {
  run: OperationRun;
  steps: OperationStepRun[];
};

export type WorkspaceCleanupInspection = {
  agentId: string;
  eligible: boolean;
  reason: string;
  estimatedBytes: number;
};

export type WorkspaceCleanupRecord = {
  id: string;
  projectId: string;
  agentId: string | null;
  workingDirectory: string;
  branch: string | null;
  outcome: string;
  reason: string;
  freedBytes: number | null;
  createdAt: string;
};
