import { getAdminToken } from './auth';

const base = import.meta.env.VITE_API_BASE_URL ?? '';

export type ControlPlaneEvent = {
  sequence: number;
  type: string;
  projectId: string | null;
  entityId: string | null;
  occurredAt: string;
};

export async function consumeControlPlaneEvents(
  onEvent: (event: ControlPlaneEvent) => void,
  signal: AbortSignal
): Promise<void> {
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeFrames(buffer, onEvent);
    }
  } finally {
    reader.releaseLock();
  }
}

function consumeFrames(buffer: string, onEvent: (event: ControlPlaneEvent) => void): string {
  let remaining = buffer;
  while (true) {
    const boundary = remaining.indexOf('\n\n');
    if (boundary < 0) return remaining;
    const frame = remaining.slice(0, boundary).replaceAll('\r', '');
    remaining = remaining.slice(boundary + 2);

    const eventName = lineValue(frame, 'event:');
    if (eventName !== 'control-plane') continue;
    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;

    try {
      onEvent(JSON.parse(data) as ControlPlaneEvent);
    } catch {
      // A malformed frame must not tear down the durable reconnect loop.
    }
  }
}

function lineValue(frame: string, prefix: string): string | null {
  const line = frame.split('\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}
