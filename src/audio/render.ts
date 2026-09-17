// renderAudioSettings(model) — the OUTPUT injection (docs/DESIGN.md §7.1).
//
// Pure math over the granted AbilityModel slice, written in the style of the
// toolkit's surfaces/xr.js: dimensions in, one vendor-neutral render out.
// XR's renderer only carries speech.rate and simplifyLanguage; an audio-first
// surface needs delivery SHAPE — pacing, pause length, utterance size,
// gist-first — which is exactly what this adds. `model: null` → all defaults,
// and that IS baseline: the same engine speaks, unshaped, at 1.0×.
//
// Vendor mapping (ElevenLabs SpeakOptions, Gemini TTS style line) lives in
// the sibling modules elevenlabs-map.ts / gemini-style.ts, never here.

import type { AbilityModel, Need } from '@ai4a11y/toolkit';

export interface AudioRender {
  speech: {
    rate: number;                       // 1.0 = engine default
    pitchPreference: 'low' | 'standard';
    expressiveness: 'steady' | 'natural';
    volume: number;                     // 0–1
    pauseAfterUtteranceMs: number;
  };
  delivery: {
    mode: 'continuous' | 'stepwise';
    confirmToAdvance: boolean;
    maxWordsPerUtterance: number | null;
    gistFirst: boolean;
  };
  language: {
    simplify: boolean;
    readingLevel: string | number | null;
    language: string;
  };
  captionsMirror: boolean;
}

const STRENGTH_RANK: Record<string, number> = { floor: 3, preference: 2, hint: 1 };

// The strongest need for a dimension (floor > preference > hint; first wins ties).
function need(model: AbilityModel | null, dimension: string): Need | undefined {
  const needs = model?.needs;
  if (!Array.isArray(needs)) return undefined;
  let best: Need | undefined;
  for (const n of needs) {
    if (n.dimension !== dimension) continue;
    if (!best || (STRENGTH_RANK[n.strength] ?? 0) > (STRENGTH_RANK[best.strength] ?? 0)) best = n;
  }
  return best;
}

function truthy(n: Need | undefined): boolean {
  return n != null && n.value !== false && n.value !== 0 && n.value !== '' && n.value != null;
}

export function renderAudioSettings(model: AbilityModel | null): AudioRender {
  const rateNeed = need(model, 'readAloudRate');
  const rate = typeof rateNeed?.value === 'number' && Number.isFinite(rateNeed.value) ? rateNeed.value : 1.0;

  const pitchNeed = need(model, 'voicePitch');
  const pitchPreference = pitchNeed?.value === 'low' ? 'low' : 'standard';

  const pacingNeed = need(model, 'pacing');
  const stepwise = pacingNeed?.value === 'stepwise';

  const simplify = truthy(need(model, 'simplify'));

  const detailNeed = need(model, 'spokenDetail');
  // Spec: gistFirst ← needs spokenDetail === 'gist', else simplify.
  const gistFirst = detailNeed != null ? detailNeed.value === 'gist' : simplify;

  const hearing = Array.isArray(model?.supportAreas) && model.supportAreas.includes('hearing');

  return {
    speech: {
      rate,
      pitchPreference,
      expressiveness: stepwise || simplify ? 'steady' : 'natural',
      volume: hearing ? 1.0 : 0.85,
      pauseAfterUtteranceMs: stepwise ? 900 : 250,
    },
    delivery: {
      mode: stepwise ? 'stepwise' : 'continuous',
      confirmToAdvance: stepwise,
      maxWordsPerUtterance: stepwise ? 18 : null,
      gistFirst,
    },
    language: {
      simplify,
      readingLevel: model?.readingLevel ?? null,
      language: model?.language || 'standard',
    },
    captionsMirror: truthy(need(model, 'captions')),
  };
}
