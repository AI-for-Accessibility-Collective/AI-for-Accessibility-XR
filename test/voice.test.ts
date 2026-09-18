// voice.test.ts — speed clamp 0.7–1.2; steady → stability/style;
// constant voice_id under FILM_MODE (the same-voice A/B rule).

import { describe, expect, test } from 'bun:test';
import { toSpeakOptions, LOW_PITCH_VOICE_ID } from '../src/toolkit-candidates/adapters/voice.ts';
import { renderXRAudioSettings } from '../src/toolkit-candidates/xr-audio.ts';
import type { AbilityModel } from '@ai4a11y/toolkit';
import fixture from './fixtures/margaret.blob.json';

const margaret = renderXRAudioSettings(fixture.abilityModel as AbilityModel);
const baseline = renderXRAudioSettings(null);

describe('speed', () => {
  test('margaret 0.8 passes through', () => {
    expect(toSpeakOptions(margaret).voice_settings?.speed).toBe(0.8);
  });
  test('clamped at 0.7 floor (repeat slowdown at the edge)', () => {
    expect(toSpeakOptions(margaret, { rateDelta: -0.2 }).voice_settings?.speed).toBe(0.7);
  });
  test('clamped at 1.2 ceiling', () => {
    const fast = renderXRAudioSettings({ needs: [{ dimension: 'readAloudRate', value: 1.6, strength: 'preference' }] });
    expect(toSpeakOptions(fast).voice_settings?.speed).toBe(1.2);
  });
  test('repeat slowdown: 0.8 − 0.1 → 0.7', () => {
    expect(toSpeakOptions(margaret, { rateDelta: -0.1 }).voice_settings?.speed).toBeCloseTo(0.7, 5);
  });
});

describe('expressiveness', () => {
  test('steady → stability 0.75, style 0', () => {
    const o = toSpeakOptions(margaret);
    expect(o.voice_settings?.stability).toBe(0.75);
    expect(o.voice_settings?.style).toBe(0);
  });
  test('natural (baseline) → no stability/style overrides', () => {
    const o = toSpeakOptions(baseline);
    expect(o.voice_settings?.stability).toBeUndefined();
    expect(o.voice_settings?.style).toBeUndefined();
  });
});

describe('volume', () => {
  test('hearing support → volume 1.0 with speaker boost', () => {
    const o = toSpeakOptions(margaret);
    expect(o.volume).toBe(1.0);
    expect(o.voice_settings?.use_speaker_boost).toBe(true);
  });
  test('baseline → 0.85, no boost', () => {
    const o = toSpeakOptions(baseline);
    expect(o.volume).toBe(0.85);
    expect(o.voice_settings?.use_speaker_boost).toBeUndefined();
  });
});

describe('voice_id — the same-voice A/B rule', () => {
  const lowPitch = renderXRAudioSettings({ needs: [{ dimension: 'voicePitch', value: 'low', strength: 'preference' }] });

  test('FILM_MODE: the configured voice, constant, in both renders', () => {
    const a = toSpeakOptions(baseline, { filmMode: true, voiceId: 'FILM_VOICE' });
    const b = toSpeakOptions(margaret, { filmMode: true, voiceId: 'FILM_VOICE' });
    expect(a.voice_id).toBe('FILM_VOICE');
    expect(b.voice_id).toBe('FILM_VOICE');
  });
  test('FILM_MODE disables the voicePitch swap', () => {
    const o = toSpeakOptions(lowPitch, { filmMode: true, voiceId: 'FILM_VOICE' });
    expect(o.voice_id).toBe('FILM_VOICE');
  });
  test('FILM_MODE with no configured voice omits voice_id (server default)', () => {
    expect(toSpeakOptions(margaret, { filmMode: true, voiceId: '' }).voice_id).toBeUndefined();
  });
  test('outside film mode, voicePitch low selects the curated low-pitch voice', () => {
    expect(toSpeakOptions(lowPitch, { filmMode: false }).voice_id).toBe(LOW_PITCH_VOICE_ID);
  });
});
