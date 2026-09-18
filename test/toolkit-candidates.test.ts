// toolkit-candidates.test.ts — the folder's one rule, enforced: everything
// under src/toolkit-candidates/ may import the toolkit and its own siblings,
// NEVER the rest of the app. That is what keeps a later move into the toolkit
// a copy, not a rewrite.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chunkText, deliverPaced } from '../src/toolkit-candidates/adapters/paced-delivery.ts';
import { renderXRAudioSettings } from '../src/toolkit-candidates/xr-audio.ts';
import type { AbilityModel } from '@ai4a11y/toolkit';

const ROOT = resolve(import.meta.dir, '../src/toolkit-candidates');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('toolkit-candidates', () => {
  test('imports only the toolkit and files inside the folder', () => {
    const found = files(ROOT);
    expect(found.length).toBeGreaterThan(0);
    for (const file of found) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        if (spec.startsWith('.')) {
          expect(resolve(file, '..', spec).startsWith(ROOT)).toBe(true);
        } else {
          expect(spec === '@ai4a11y/toolkit' || spec.startsWith('@ai4a11y/toolkit/')).toBe(true);
        }
      }
    }
  });

  test('needs resolve like the toolkit XR surface: stronger wins, ties go to the later entry', () => {
    const model = {
      needs: [
        { dimension: 'pacing', value: 'stepwise', strength: 'preference' },
        { dimension: 'pacing', value: 'continuous', strength: 'preference' },
        { dimension: 'voicePitch', value: 'low', strength: 'floor' },
        { dimension: 'voicePitch', value: 'standard', strength: 'hint' },
        { dimension: 'readAloudRate', value: 0.9, strength: 'preference' },
        { dimension: 'readAloudRate', value: 0.8, strength: 'preference' },
      ],
    } as unknown as AbilityModel;
    const r = renderXRAudioSettings(model);
    expect(r.delivery.mode).toBe('continuous');
    expect(r.speech.pitchPreference).toBe('low');
    expect(r.speech.rate).toBe(0.8);
  });

  test('deliverPaced: chunks, pauses between (not after), stops when cancelled', async () => {
    const settings = renderXRAudioSettings({
      needs: [{ dimension: 'pacing', value: 'stepwise', strength: 'preference' }],
    } as unknown as AbilityModel);
    const text = 'Open the door now please. ' + 'Put the clothes inside the big drum slowly. '.repeat(3);
    const expected = chunkText(text, settings.delivery.maxWordsPerUtterance);
    expect(expected.length).toBeGreaterThan(1);

    const spoken: string[] = [];
    const pauses: number[] = [];
    await deliverPaced(text, settings, async (c) => void spoken.push(c), {
      sleep: async (ms) => void pauses.push(ms),
    });
    expect(spoken).toEqual(expected);
    expect(pauses).toEqual(Array(expected.length - 1).fill(settings.speech.pauseAfterUtteranceMs));

    const partial: string[] = [];
    await deliverPaced(text, settings, async (c) => void partial.push(c), {
      sleep: async () => {},
      cancelled: () => partial.length >= 1,
    });
    expect(partial).toEqual([expected[0]!]);
  });
});
