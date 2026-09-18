// xr-audio.test.ts — every field of renderXRAudioSettings vs the spec table
// (docs/DESIGN.md §7.1), for Margaret's model and for null (= baseline).

import { describe, expect, test } from 'bun:test';
import { renderXRAudioSettings } from '../src/toolkit-candidates/xr-audio.ts';
import type { AbilityModel } from '@ai4a11y/toolkit';
import fixture from './fixtures/margaret.blob.json';

const margaret = fixture.abilityModel as AbilityModel;

describe('renderXRAudioSettings(margaret)', () => {
  const r = renderXRAudioSettings(margaret);

  test('speech.rate ← needs readAloudRate', () => expect(r.speech.rate).toBe(0.8));
  test('speech.pitchPreference default standard (no voicePitch need)', () =>
    expect(r.speech.pitchPreference).toBe('standard'));
  test('speech.expressiveness steady (stepwise + simplify)', () =>
    expect(r.speech.expressiveness).toBe('steady'));
  test('speech.volume 1.0 (supportAreas includes hearing)', () => expect(r.speech.volume).toBe(1.0));
  test('speech.pauseAfterUtteranceMs 900 (stepwise)', () => expect(r.speech.pauseAfterUtteranceMs).toBe(900));
  test('delivery.mode stepwise ← needs pacing', () => expect(r.delivery.mode).toBe('stepwise'));
  test('delivery.confirmToAdvance true (stepwise)', () => expect(r.delivery.confirmToAdvance).toBe(true));
  test('delivery.maxWordsPerUtterance ~18 (stepwise)', () => expect(r.delivery.maxWordsPerUtterance).toBe(18));
  test('delivery.gistFirst true (no spokenDetail need → simplify)', () => expect(r.delivery.gistFirst).toBe(true));
  test('language.simplify ← needs simplify', () => expect(r.language.simplify).toBe(true));
  test('language.readingLevel pass-through (null)', () => expect(r.language.readingLevel).toBeNull());
  test('language.language pass-through', () => expect(r.language.language).toBe('standard'));
  test('captionsMirror ← needs captions', () => expect(r.captionsMirror).toBe(true));
});

describe('renderXRAudioSettings(null) — baseline defaults', () => {
  const r = renderXRAudioSettings(null);

  test('rate 1.0', () => expect(r.speech.rate).toBe(1.0));
  test('pitch standard', () => expect(r.speech.pitchPreference).toBe('standard'));
  test('expressiveness natural', () => expect(r.speech.expressiveness).toBe('natural'));
  test('volume 0.85', () => expect(r.speech.volume).toBe(0.85));
  test('pause 250ms', () => expect(r.speech.pauseAfterUtteranceMs).toBe(250));
  test('mode continuous', () => expect(r.delivery.mode).toBe('continuous'));
  test('confirmToAdvance false', () => expect(r.delivery.confirmToAdvance).toBe(false));
  test('maxWords null (no chunking — raw pass-through)', () => expect(r.delivery.maxWordsPerUtterance).toBeNull());
  test('gistFirst false', () => expect(r.delivery.gistFirst).toBe(false));
  test('simplify false', () => expect(r.language.simplify).toBe(false));
  test('captionsMirror false', () => expect(r.captionsMirror).toBe(false));
});

describe('individual derivations', () => {
  test('spokenDetail gist forces gistFirst even without simplify', () => {
    const r = renderXRAudioSettings({ needs: [{ dimension: 'spokenDetail', value: 'gist', strength: 'preference' }] });
    expect(r.delivery.gistFirst).toBe(true);
    expect(r.language.simplify).toBe(false);
  });
  test('spokenDetail full suppresses gistFirst even with simplify', () => {
    const r = renderXRAudioSettings({
      needs: [
        { dimension: 'spokenDetail', value: 'full', strength: 'preference' },
        { dimension: 'simplify', value: true, strength: 'preference' },
      ],
    });
    expect(r.delivery.gistFirst).toBe(false);
  });
  test('voicePitch low is carried (film mode gating happens in the map, not here)', () => {
    const r = renderXRAudioSettings({ needs: [{ dimension: 'voicePitch', value: 'low', strength: 'preference' }] });
    expect(r.speech.pitchPreference).toBe('low');
  });
  test('floor beats preference for the same dimension', () => {
    const r = renderXRAudioSettings({
      needs: [
        { dimension: 'readAloudRate', value: 0.9, strength: 'preference' },
        { dimension: 'readAloudRate', value: 0.7, strength: 'floor' },
      ],
    });
    expect(r.speech.rate).toBe(0.7);
  });
  test('simplify alone → steady expressiveness, continuous mode', () => {
    const r = renderXRAudioSettings({ needs: [{ dimension: 'simplify', value: true, strength: 'preference' }] });
    expect(r.speech.expressiveness).toBe('steady');
    expect(r.delivery.mode).toBe('continuous');
    expect(r.speech.pauseAfterUtteranceMs).toBe(250);
  });
});
