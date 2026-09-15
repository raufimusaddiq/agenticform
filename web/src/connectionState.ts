export type ConnectionState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'AUTH_REQUIRED';

export function combinedConnectionState(events: ConnectionState, agents: ConnectionState, snapshotCurrent: boolean): ConnectionState {
  for (const state of ['AUTH_REQUIRED', 'DISCONNECTED', 'RECONNECTING', 'CONNECTING'] as const) {
    if (events === state || agents === state) return state;
  }
  return snapshotCurrent ? 'CONNECTED' : 'RECONNECTING';
}
