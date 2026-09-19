import { getAdminToken } from './auth';
import type { Agent } from './types';
import type { ConnectionState } from './ui';

const base = import.meta.env.VITE_API_BASE_URL ?? '';

export type ControlPlaneEvent = {
  sequence: number;
  type: string;
  projectId: string | null;
  entityId: string | null;
  occurredAt: string;
};

export type AgentRunOutput = { agentId: string; text: string; occurredAt: string };

export async function consumeControlPlaneEvents(
  onEvent: (event: ControlPlaneEvent) => void,
  signal: AbortSignal,
  onState?: (state: ConnectionState) => void,
  onRun?: (output: AgentRunOutput) => void
): Promise<void> {
  onState?.('CONNECTING');
  const token = getAdminToken();
  const response = await fetch(`${base}/api/events/stream`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    signal
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('ADMIN_AUTH_REQUIRED');
    throw new Error(`Event stream failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error('Event stream response has no body');
  onState?.('CONNECTED');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeFrames(buffer, onEvent, onRun);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function consumeAgentStream(
  onAgents: (agents: Agent[]) => void,
  signal: AbortSignal,
  onState?: (state: ConnectionState) => void
): Promise<void> {
  onState?.('CONNECTING');
  const token = getAdminToken();
  const response = await fetch(`${base}/api/agents/stream`, {
    headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('ADMIN_AUTH_REQUIRED');
    throw new Error(`Agent stream failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error('Agent stream response has no body');
  onState?.('CONNECTED');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeAgentFrames(buffer, onAgents);
    }
  } finally { reader.releaseLock(); }
}

function consumeAgentFrames(buffer: string, onAgents: (agents: Agent[]) => void): string {
  let remaining = buffer.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  while (true) {
    const boundary = remaining.indexOf('\n\n');
    if (boundary < 0) return remaining;
    const frame = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + 2);
    if (lineValue(frame, 'event:') !== 'agents') continue;
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    try { onAgents(JSON.parse(data) as Agent[]); } catch { /* reconnect loop remains durable */ }
  }
}

export function consumeFrames(
  buffer: string,
  onEvent: (event: ControlPlaneEvent) => void,
  onRun?: (output: AgentRunOutput) => void
): string {
  // SSE permits LF and CRLF line endings. Normalize before frame detection so proxy/server
  // choices cannot silently disable UI updates.
  let remaining = buffer.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  while (true) {
    const boundary = remaining.indexOf('\n\n');
    if (boundary < 0) return remaining;
    const frame = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + 2);

    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;

    const eventName = lineValue(frame, 'event:');
    try {
      if (eventName === 'agent-run') onRun?.(JSON.parse(data) as AgentRunOutput);
      else if (eventName === 'control-plane') onEvent(JSON.parse(data) as ControlPlaneEvent);
    } catch {
      // A malformed frame must not tear down the durable reconnect loop.
    }
  }
}

function lineValue(frame: string, prefix: string): string | null {
  const line = frame.split('\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}
