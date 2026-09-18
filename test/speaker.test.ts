// speaker.test.ts — chunking; pause timing (fake sleep); transcript-replay
// repeat + second-repeat slowdown; stop cancels.

import { describe, expect, test } from 'bun:test';
import { createSpeaker, type UtteranceMeta } from '../src/audio/speaker.ts';
import { chunkText } from '../src/toolkit-candidates/adapters/paced-delivery.ts';
import { renderXRAudioSettings } from '../src/toolkit-candidates/xr-audio.ts';
import type { AbilityModel } from '@ai4a11y/toolkit';
import fixture from './fixtures/margaret.blob.json';

const margaretRender = () => renderXRAudioSettings(fixture.abilityModel as AbilityModel);
const baselineRender = () => renderXRAudioSettings(null);

function harness(render = margaretRender()) {
  const spoken: Array<{ text: string; meta: UtteranceMeta }> = [];
  const sleeps: number[] = [];
  const speaker = createSpeaker(
    { speak: async (text, meta) => void spoken.push({ text, meta }) },
    render,
    {
      sleep: async (ms) => void sleeps.push(ms),
      mapOpts: { filmMode: true, voiceId: '' },
    },
  );
  return { speaker, spoken, sleeps };
}

const LONG =
  'Pull open the drawer. Put the soap in the left section. Close it gently. ' +
  'Now turn the big dial to Cottons. Then press the start button and hold it until the light comes on.';

describe('chunkText', () => {
  test('null maxWords → one chunk (baseline pass-through)', () => {
    expect(chunkText(LONG, null)).toHaveLength(1);
  });
  test('packs sentences under the word budget, never splits mid-sentence', () => {
    const chunks = chunkText(LONG, 18);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.trim()).toMatch(/[.!?]$/);
    // Re-joined text is the original.
    expect(chunks.join(' ')).toBe(LONG.replace(/\s+/g, ' ').trim());
  });
  test('a single overlong sentence stays whole', () => {
    const s = 'This single sentence has quite a lot of words in it and definitely exceeds the budget of eighteen words overall.';
    expect(chunkText(s, 18)).toEqual([s]);
  });
});

describe('say — toolkit shaping', () => {
  test('chunks at 18 words with 900ms pauses between (not after the last)', async () => {
    const { speaker, spoken, sleeps } = harness();
    await speaker.say(LONG, { stepId: 'step-1' });
    expect(spoken.length).toBeGreaterThan(1);
    expect(sleeps).toHaveLength(spoken.length - 1);
    for (const ms of sleeps) expect(ms).toBe(900);
    expect(spoken[0]!.meta.speakOptions.voice_settings?.speed).toBe(0.8);
  });
  test('baseline: one unshaped chunk, no pauses, 1.0×', async () => {
    const { speaker, spoken, sleeps } = harness(baselineRender());
    await speaker.say(LONG);
    expect(spoken).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect(spoken[0]!.meta.speakOptions.voice_settings?.speed).toBe(1.0);
  });
});

describe('repeat — transcript replay', () => {
  test('replays verbatim at the same rate the first time', async () => {
    const { speaker, spoken } = harness();
    await speaker.say('Turn the big dial to Cottons.', { stepId: 'step-2' });
    const first = spoken.map((s) => s.text);
    const had = await speaker.repeat();
    expect(had).toBe(true);
    const replay = spoken.slice(first.length).map((s) => s.text);
    expect(replay).toEqual(first);
    expect(spoken.at(-1)!.meta.speakOptions.voice_settings?.speed).toBe(0.8);
    expect(spoken.at(-1)!.meta.slower).toBe(false);
  });
  test('second repeat of the same step slows by 0.1, same words', async () => {
    const { speaker, spoken } = harness();
    await speaker.say('Turn the big dial to Cottons.', { stepId: 'step-2' });
    await speaker.repeat();
    await speaker.repeat();
    const lastMeta = spoken.at(-1)!.meta;
    expect(lastMeta.slower).toBe(true);
    expect(lastMeta.speakOptions.voice_settings?.speed).toBeCloseTo(0.7, 5);
    expect(spoken.at(-1)!.text).toBe('Turn the big dial to Cottons.');
  });
  test('the slowdown is exactly 0.1 below the current rate (checked above the 0.7 floor)', async () => {
    const { speaker, spoken } = harness(baselineRender());
    await speaker.say('Turn the dial.', { stepId: 'step-1' });
    await speaker.repeat();
    await speaker.repeat();
    expect(spoken.at(-1)!.meta.slower).toBe(true);
    expect(spoken.at(-1)!.meta.speakOptions.voice_settings?.speed).toBeCloseTo(0.9, 5);
  });
  test('repeat with nothing said returns false', async () => {
    const { speaker } = harness();
    expect(await speaker.repeat()).toBe(false);
  });
  test('a new step resets the utterance being replayed', async () => {
    const { speaker, spoken } = harness();
    await speaker.say('Open the drawer.', { stepId: 'step-1' });
    await speaker.say('Turn the dial.', { stepId: 'step-2' });
    await speaker.repeat();
    expect(spoken.at(-1)!.text).toBe('Turn the dial.');
    expect(speaker.transcript()).toBe('Turn the dial.');
  });
});

describe('reset — mode/task boundaries', () => {
  test('clears repeat counts so a prior take cannot slow the next', async () => {
    const { speaker, spoken } = harness();
    await speaker.say('Turn the dial.', { stepId: 'step-2' });
    await speaker.repeat(); // count 1 for step-2
    speaker.reset(); // ← the mode switch
    await speaker.say('Turn the dial.', { stepId: 'step-2' });
    await speaker.repeat(); // count 1 again — NOT 2
    expect(spoken.at(-1)!.meta.slower).toBe(false);
  });
  test('clears the transcript', async () => {
    const { speaker } = harness();
    await speaker.say('Something.');
    speaker.reset();
    expect(speaker.transcript()).toBeNull();
    expect(await speaker.repeat()).toBe(false);
  });
});

describe('stop', () => {
  test('cancels pending chunks mid-utterance', async () => {
    const spoken: string[] = [];
    let stopper: (() => void) | null = null;
    const speaker = createSpeaker(
      {
        speak: async (text) => {
          spoken.push(text);
          stopper?.(); // stop() after the first chunk is delivered
          stopper = null;
        },
      },
      margaretRender(),
      { sleep: async () => {} },
    );
    stopper = () => speaker.stop();
    await speaker.say(LONG, { stepId: 'step-1' });
    expect(spoken).toHaveLength(1);
  });

  test('also cancels every line queued behind the one being spoken', async () => {
    const spoken: string[] = [];
    let stopper: (() => void) | null = null;
    const speaker = createSpeaker(
      {
        speak: async (text) => {
          spoken.push(text);
          stopper?.();
          stopper = null;
        },
      },
      margaretRender(),
      { sleep: async () => {} },
    );
    stopper = () => speaker.stop();
    const first = speaker.say(LONG, { stepId: 'step-1' });
    const second = speaker.say('Now press the start button.', { stepId: 'step-2' });
    const third = speaker.repeat();
    await Promise.all([first, second, third]);
    // One chunk of step 1 went out; step 2 and the repeat never did.
    expect(spoken).toHaveLength(1);
    // A line said AFTER the stop speaks again.
    await speaker.say('Starting now.', { stepId: 'canned' });
    expect(spoken[1]).toBe('Starting now.');
    expect(spoken).toHaveLength(2);
  });
});

describe('setRender — live A/B toggle', () => {
  test('re-shapes the NEXT utterance', async () => {
    const { speaker, spoken, sleeps } = harness(baselineRender());
    await speaker.say(LONG);
    expect(spoken).toHaveLength(1);
    speaker.setRender(margaretRender());
    await speaker.say(LONG, { stepId: 'step-1' });
    expect(spoken.length).toBeGreaterThan(2);
    expect(sleeps.some((ms) => ms === 900)).toBe(true);
  });
});
