import type { ReactNode } from 'react';

export type ConnectionState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'AUTH_REQUIRED';

const statusLabels: Record<string, string> = {
  WAITING_APPROVAL: 'Needs approval',
  WAITING_DEPENDENCY: 'Waiting on dependency',
  WAITING_EXTERNAL: 'Waiting on external system',
  IN_THE_LOOP: 'Human in the loop',
  ON_THE_LOOP: 'Human on the loop',
  REQUIRE_HUMAN: 'Require human',
  AUTO_APPROVED: 'Auto approved',
  PREAUTHORIZED: 'Preauthorized',
  POLICY_DENIED: 'Policy denied'
};

export function label(value: string) {
  return statusLabels[value] ?? value.toLowerCase().replaceAll('_', ' ');
}

export function shortId(value: string | null | undefined) {
  return value ? `${value.slice(0, 8)}...` : '-';
}

export function Status({ value, children }: { value: string; children?: ReactNode }) {
  const text = children ?? label(value);
  return <span className={`status status-${value.toLowerCase()}`} aria-label={typeof text === 'string' ? text : label(value)}><span className="status-dot" aria-hidden="true" />{text}</span>;
}

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  const text = label(state);
  return <span className={`connection-status connection-${state.toLowerCase()}`}><span className="connection-marker" aria-hidden="true" />Control plane <strong>{text}</strong></span>;
}

export function HumanControlIndicator({ mode }: { mode: 'IN_THE_LOOP' | 'ON_THE_LOOP' }) {
  return <span className={`human-control human-control-${mode.toLowerCase()}`}><span aria-hidden="true" />{label(mode)}</span>;
}

export function LoadingState({ label: text = 'Loading' }: { label?: string }) {
  return <div className="loading-state" role="status" aria-live="polite"><span className="loading-line loading-line-wide" /><span className="loading-line" /><small>{text}</small></div>;
}
