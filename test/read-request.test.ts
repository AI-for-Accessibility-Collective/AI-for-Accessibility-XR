// read-request.test.ts — which utterances ask to read what the camera sees.

import { describe, expect, test } from 'bun:test';
import { isReadRequest } from '../src/skills/builtin/read-text-aloud.ts';

describe('isReadRequest', () => {
  test.each([
    'read this',
    'Can you read my bill?',
    'please read the letter for me',
    'what does this say?',
    'What does this letter say?',
    'what does the bill say',
    "what's written here?",
    'what is printed on the label',
    'Read what it says',
  ])('reads: %s', (t) => {
    expect(isReadRequest(t)).toBe(true);
  });

  test.each([
    'help me start the washing machine',
    "I'm ready",
    'already done',
    'what does the dial do',
    'can you help with my bill',
  ])('does not read: %s', (t) => {
    expect(isReadRequest(t)).toBe(false);
  });
});
