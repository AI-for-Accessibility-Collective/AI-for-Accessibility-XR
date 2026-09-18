// prompt-directives.test.ts — the input injection: directives present per need,
// empty for a null model (baseline), and freeText NEVER leaks into the
// prompt (the privacy floor).

import { describe, expect, test } from 'bun:test';
import { profilePromptBlock } from '../src/toolkit-candidates/adapters/prompt-directives.ts';
import { renderXRAudioSettings } from '../src/toolkit-candidates/xr-audio.ts';
import { composePrompt } from '../src/skills/compose.ts';
import type { AbilityModel } from '@ai4a11y/toolkit';
import type { Task } from '../src/skills/types.ts';
import fixture from './fixtures/margaret.blob.json';
import washingMachine from '../src/tasks/washing-machine.json';

const SECRET = 'my daughter Ruth manages my bank account';
const margaret: AbilityModel = { ...(fixture.abilityModel as AbilityModel), freeText: SECRET };
const render = renderXRAudioSettings(margaret);

describe('profilePromptBlock(margaret)', () => {
  const block = profilePromptBlock(margaret, render);

  test('one-step directive present (stepwise)', () => {
    expect(block).toContain('exactly ONE next action');
    // The check-in is natural speech; the wearer is never told to say a keyword.
    expect(block).toContain('never an instruction to say a particular word');
    expect(block).not.toMatch(/say 'done'/);
  });
  test('short-sentence directive present (maxWords)', () => {
    expect(block).toContain('under ~18 words');
  });
  test('plain-words directive present (simplify)', () => {
    expect(block).toMatch(/Plain everyday words/);
  });
  test('nothing in the block changes with speaking rate (Kemper & Harden 1999)', () => {
    expect(block).not.toMatch(/unhurried|warm/);
    const faster: AbilityModel = {
      ...margaret,
      needs: (margaret.needs ?? []).map((n) => (n.dimension === 'readAloudRate' ? { ...n, value: 1.0 } : n)),
    };
    expect(profilePromptBlock(faster, renderXRAudioSettings(faster))).toBe(block);
  });
  test('plain words also asks for one name per object (Lewis & Vasishth)', () => {
    expect(block).toContain('one name per object');
  });
  test('clarity standard: no clear-steps directives', () => {
    expect(block).not.toContain('Start with the verb');
    expect(block).not.toContain('one new object');
    expect(block).not.toContain("Never say 'if'");
    expect(block).not.toContain('which step this is');
  });
  test('gist-first directive present', () => {
    expect(block).toMatch(/gist first/);
  });
  test('confirm-then-next directive present (stepwise)', () => {
    expect(block).toContain('When the wearer says they have done it, in whatever words, acknowledge in a few words');
  });
  test('orientation directive present (gistFirst): natural, never a bare step count', () => {
    expect(block).toContain('three or more steps');
    expect(block).toContain("never say 'this will take N steps'");
  });
  test('elderspeak guard present whenever the block is non-empty', () => {
    expect(block).toContain('capable adult');
    expect(block).toContain('no sing-song tone');
  });
  test('elderspeak guard rides along with any single directive, and names the marked features', () => {
    const captionsOnly: AbilityModel = {
      ...(fixture.abilityModel as AbilityModel),
      needs: [{ dimension: 'simplify', value: true, strength: 'preference', source: 'test' }],
    };
    const b = profilePromptBlock(captionsOnly, renderXRAudioSettings(captionsOnly));
    expect(b).toContain('capable adult');
    expect(b).toContain("no 'we' or 'let's'");
    expect(b).toContain('no tag questions');
    expect(b).not.toContain('ONE next action');
  });
  test('rate alone (no structural need) produces no block at all', () => {
    const rateOnly: AbilityModel = {
      ...(fixture.abilityModel as AbilityModel),
      needs: [{ dimension: 'readAloudRate', value: 0.8, strength: 'preference', source: 'test' }],
    };
    expect(profilePromptBlock(rateOnly, renderXRAudioSettings(rateOnly))).toBe('');
  });
  test('freeText NEVER reaches the block', () => {
    expect(block).not.toContain(SECRET);
    expect(block).not.toContain('Ruth');
  });
});

// Clear steps: each level adds exactly its lines (docs/design/working-memory-fit.md).
describe('clarity levels', () => {
  const withClarity = (value: string): string => {
    const m: AbilityModel = {
      ...(fixture.abilityModel as AbilityModel),
      needs: [...fixture.abilityModel.needs, { dimension: 'clarity', value, strength: 'preference', source: 'test' }] as AbilityModel['needs'],
    };
    return profilePromptBlock(m, renderXRAudioSettings(m));
  };
  test("'clear': action first, one new thing, ask instead of if, 12-word cap — not the step number", () => {
    const b = withClarity('clear');
    expect(b).toContain('Start with the verb');
    expect(b).toContain('at most one new object or value per sentence');
    expect(b).toContain("Never say 'if' or 'when'");
    expect(b).toContain('under ~12 words, one clause each');
    expect(b).not.toContain('which step this is');
  });
  test("'clearest': everything in clear, plus the step number and re-used names, 8-word cap", () => {
    const b = withClarity('clearest');
    expect(b).toContain('Start with the verb');
    expect(b).toContain("Say which step this is before each action ('Step 3 of 5.')");
    expect(b).toContain("'that dial'");
    expect(b).toContain('under ~8 words');
  });
  test('an unknown value is standard', () => {
    expect(withClarity('extreme')).toBe(block);
  });
  const block = profilePromptBlock(margaret, render);
});

describe('baseline (null model)', () => {
  test('block is empty', () => {
    expect(profilePromptBlock(null, renderXRAudioSettings(null))).toBe('');
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
