// renderXRAudioSettings(model) — the XR audio surface: the profile in, one
// vendor-neutral set of audio settings out.
//
// Built ON the toolkit's XR surface (surfaces/xr.js): speaking rate, simplify
// and captions come straight from renderXRSettings. XR's renderer stops
// there; an audio-first wearable also needs delivery SHAPE — pacing, pause
// length, utterance size, gist-first, pitch, volume — which is what this adds.
// `model: null` → all defaults, and that IS baseline: the same engine speaks,
// unshaped, at 1.0×.
//
// It decides; it does nothing. Carrying the settings out is the adapters' job
// (./adapters/).

import type { AbilityModel, Need } from '@ai4a11y/toolkit';
import { renderXRSettings } from '@ai4a11y/toolkit/surfaces/xr';

export interface XRAudioSettings {
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

// The winning need for a dimension, resolved the way surfaces/xr.js does it:
// stronger strength wins, ties go to the later entry.
function need(model: AbilityModel | null, dimension: string): Need | undefined {
  const needs = model?.needs;
  if (!Array.isArray(needs)) return undefined;
  let best: Need | undefined;
  for (const n of needs) {
    if (n.dimension !== dimension) continue;
    if (!best || (STRENGTH_RANK[n.strength] ?? 0) >= (STRENGTH_RANK[best.strength] ?? 0)) best = n;
  }
  return best;
}

export function renderXRAudioSettings(model: AbilityModel | null): XRAudioSettings {
  // What the toolkit's XR surface already decides.
  const xr = renderXRSettings((model ?? { needs: [] }) as Parameters<typeof renderXRSettings>[0]);
  const rate = Number.isFinite(xr.speech.rate) ? xr.speech.rate : 1.0;
  const simplify = xr.simplifyLanguage;

  // What audio adds. These three dimensions are not in the toolkit's
  // vocabulary yet (see README.md in this folder).
  const pitchPreference = need(model, 'voicePitch')?.value === 'low' ? 'low' : 'standard';
  const stepwise = need(model, 'pacing')?.value === 'stepwise';
  const detailNeed = need(model, 'spokenDetail');
  // gistFirst ← spokenDetail === 'gist'; with no spokenDetail need, simplify.
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
    captionsMirror: xr.captions.enabled,
  };
}
