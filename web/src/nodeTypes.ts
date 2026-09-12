export type NodeTrustLevel = 'UNTRUSTED' | 'STANDARD' | 'TRUSTED' | 'PRIVILEGED';
export type ExecutionNodeStatus = 'ONLINE' | 'OFFLINE' | 'DRAINING' | 'DISABLED' | 'REVOKED';

export type ExecutionNode = {
  id: string;
  name: string;
  status: ExecutionNodeStatus;
  trustLevel: NodeTrustLevel;
  fingerprint: string;
  labelsJson: string;
  capabilitiesJson: string;
  maxAgents: number;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  nodeVersion: string | null;
  cpuCores: number | null;
  memoryMb: number | null;
  diskFreeMb: number | null;
  enrolledAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NodeEnrollment = {
  token: string;
  expiresAt: string;
  setupCommand: string;
};
