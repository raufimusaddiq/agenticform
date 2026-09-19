import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combinedConnectionState } from '../src/connectionState.ts';

test('a healthy stream never hides the other stale or rejected stream', () => {
  for (const state of ['CONNECTING', 'RECONNECTING', 'DISCONNECTED', 'AUTH_REQUIRED']) {
    assert.equal(combinedConnectionState(state, 'CONNECTED', true), state);
    assert.equal(combinedConnectionState('CONNECTED', state, true), state);
  }
  assert.equal(combinedConnectionState('AUTH_REQUIRED', 'RECONNECTING', true), 'AUTH_REQUIRED');
  assert.equal(combinedConnectionState('CONNECTED', 'CONNECTED', false), 'RECONNECTING');
  assert.equal(combinedConnectionState('CONNECTED', 'CONNECTED', true), 'CONNECTED');
});
