// prompt-block.test.ts — the input injection: directives present per need,
// empty for a null model (baseline), and freeText NEVER leaks into the
// prompt (the privacy floor).

import { describe, expect, test } from 'bun:test';
import { profilePromptBlock } from '../src/toolkit/prompt-block.ts';
import { renderAudioSettings } from '../src/audio/render.ts';
import { composePrompt } from '../src/skills/compose.ts';
import type { AbilityModel } from '@ai4a11y/toolkit';
import type { Task } from '../src/skills/types.ts';
import fixture from './fixtures/margaret.blob.json';
import washingMachine from '../src/tasks/washing-machine.json';

const SECRET = 'my daughter Ruth manages my bank account';
const margaret: AbilityModel = { ...(fixture.abilityModel as AbilityModel), freeText: SECRET };
const render = renderAudioSettings(margaret);

describe('profilePromptBlock(margaret)', () => {
  const block = profilePromptBlock(margaret, render);

  test('one-step directive present (stepwise)', () => {
    expect(block).toContain('exactly ONE next action');
    expect(block).toContain("wait for the user to say 'done'");
  });
  test('short-sentence directive present (maxWords)', () => {
    expect(block).toContain('under ~18 words');
  });
  test('plain-words directive present (simplify)', () => {
    expect(block).toMatch(/Plain everyday words/);
  });
  test('calm-pacing directive present (rate < 1)', () => {
    expect(block).toMatch(/Calm, unhurried/);
  });
  test('gist-first directive present', () => {
    expect(block).toMatch(/gist first/);
  });
  test('confirm-then-next directive present (stepwise)', () => {
    expect(block).toContain("When the user says 'done', acknowledge it in a few words");
  });
  test('orientation directive present (gistFirst): step count only', () => {
    expect(block).toContain('how many steps it has');
    expect(block).toContain('the count only');
  });
  test('elderspeak guard present whenever the block is non-empty', () => {
    expect(block).toContain('capable adult');
    expect(block).toContain('no sing-song tone');
  });
  test('elderspeak guard rides along with any single directive', () => {
    const rateOnly: AbilityModel = {
      ...(fixture.abilityModel as AbilityModel),
      needs: [{ dimension: 'readAloudRate', value: 0.8, strength: 'preference', source: 'test' }],
    };
    const b = profilePromptBlock(rateOnly, renderAudioSettings(rateOnly));
    expect(b).toContain('Calm, unhurried');
    expect(b).toContain('capable adult');
    expect(b).not.toContain('ONE next action');
  });
  test('freeText NEVER reaches the block', () => {
    expect(block).not.toContain(SECRET);
    expect(block).not.toContain('Ruth');
  });
});

describe('baseline (null model)', () => {
  test('block is empty', () => {
    expect(profilePromptBlock(null, renderAudioSettings(null))).toBe('');
  });
  test('composePrompt without block carries no profile directives', () => {
    const si = composePrompt({ task: washingMachine as Task, profileBlock: '' });
    expect(si).not.toContain('USER PROFILE');
    expect(si).not.toContain('ONE next action');
    expect(si).not.toContain('capable adult');
    expect(si).toContain('compartment II'); // the manual-register brief is there
  });
});

describe('freeText never leaks through composePrompt either', () => {
  test('full toolkit prompt contains directives but not freeText', () => {
    const block = profilePromptBlock(margaret, render);
    const si = composePrompt({ task: washingMachine as Task, profileBlock: block });
    expect(si).toContain('USER PROFILE');
    expect(si).not.toContain(SECRET);
  });
});
