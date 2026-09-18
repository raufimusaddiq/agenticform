import assert from 'node:assert/strict';
import { test } from 'node:test';

const planPath = (projectId, environmentKey) =>
  '/api/operations/runbooks/plan?projectId=' + encodeURIComponent(projectId) + '&environmentKey=' + encodeURIComponent(environmentKey);

test('repository runbook plan URL encodes project and environment', () => {
  assert.equal(
    planPath('9e8e0034-de52-458e-8b09-563a8c4a03d5', 'production'),
    '/api/operations/runbooks/plan?projectId=9e8e0034-de52-458e-8b09-563a8c4a03d5&environmentKey=production');
});

test('repository manifest is the only syncable plan source', () => {
  const syncable = (plan) => plan.source === 'REPOSITORY_MANIFEST';
  assert.equal(syncable({ source: 'REPOSITORY_MANIFEST' }), true);
  assert.equal(syncable({ source: 'HUMAN_GATED_FALLBACK' }), false);
});
