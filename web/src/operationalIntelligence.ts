import { getAdminToken } from './auth';

export type OperationalSeverity = 'INFO' | 'WARNING' | 'HIGH' | 'CRITICAL';
export type OperationalSignalStatus = 'OPEN' | 'CORRELATED' | 'RESOLVED' | 'SUPPRESSED';
export type OperationalIncidentStatus = 'OPEN' | 'INVESTIGATING' | 'MITIGATING' | 'RESOLVED' | 'SUPPRESSED';
export type OperationalWakeStatus = 'PENDING' | 'QUEUED' | 'DELIVERED' | 'FAILED';

export type OperationalSignal = {
  id: string;
  projectId: string;
  source: string;
  signalType: string;
  severity: OperationalSeverity;
  fingerprint: string;
  correlationKey: string | null;
  payloadJson: string;
  status: OperationalSignalStatus;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type OperationalIncident = {
  id: string;
  projectId: string;
  incidentType: string;
  severity: OperationalSeverity;
  status: OperationalIncidentStatus;
  fingerprint: string;
  title: string;
  summary: string;
  suspectedChange: string | null;
  operationalAgentId: string | null;
  wakeStatus: OperationalWakeStatus;
  wakeAttempts: number;
  wakeCommandId: string | null;
  queuedSubmissionId: string | null;
  turnId: string | null;
  lastWakeError: string | null;
  resolutionSummary: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OperationalIncidentDetail = {
  incident: OperationalIncident;
  signals: OperationalSignal[];
};

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

function query(projectId?: string, status?: string) {
  const params = new URLSearchParams();
  if (projectId && projectId !== 'all') params.set('projectId', projectId);
  if (status) params.set('status', status);
  const value = params.toString();
  return value ? `?${value}` : '';
}

export const operationalIntelligenceApi = {
  signals: (projectId?: string, status?: OperationalSignalStatus) =>
    request<OperationalSignal[]>(`/api/operational-intelligence/signals${query(projectId, status)}`),
  incidents: (projectId?: string, status?: OperationalIncidentStatus) =>
    request<OperationalIncident[]>(`/api/operational-intelligence/incidents${query(projectId, status)}`),
  incident: (incidentId: string) =>
    request<OperationalIncidentDetail>(`/api/operational-intelligence/incidents/${incidentId}`),
  transitionIncident: (incidentId: string, status: OperationalIncidentStatus, summary?: string) =>
    request<OperationalIncident>(`/api/operational-intelligence/incidents/${incidentId}/status`, {
      method: 'POST', body: JSON.stringify({ status, summary })
    }),
  retryWake: (incidentId: string) =>
    request<OperationalIncident>(`/api/operational-intelligence/incidents/${incidentId}/retry-wake`, { method: 'POST' })
};
