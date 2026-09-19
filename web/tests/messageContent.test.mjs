import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayMessageContent } from '../src/messageContent.ts';

test('escaped line breaks from agent messages render as real line breaks', () => {
  assert.equal(displayMessageContent('a\\nb'), 'a\nb');
  assert.equal(displayMessageContent('a\\r\\nb'), 'a\nb');
  assert.equal(displayMessageContent('a\\rb'), 'a\nb');
});

test('already multi-line content is unchanged', () => {
  assert.equal(displayMessageContent('a\nb'), 'a\nb');
});
