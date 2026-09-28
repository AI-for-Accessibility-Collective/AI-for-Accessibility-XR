// effectLines — what the guide will do with a profile, in plain words: each
// adapter describes its own adaptation, in the order the panels show them.
//
// adaptationTags — the same adapters by their short names, for ONE spoken
// line: which of them shaped it, from the settings that line was spoken with.

import type { AbilityModel } from '@ai4a11y/toolkit';
import { renderXRAudioSettings, type XRAudioSettings } from './xr-audio.ts';
import * as oneStep from './adapters/one-step.ts';
import * as voice from './adapters/voice.ts';
import * as actionFirst from './adapters/action-first.ts';
import * as plainWords from './adapters/plain-words.ts';
import * as gistFirst from './adapters/gist-first.ts';
import * as captions from './adapters/captions.ts';

export function effectLines(model: AbilityModel | null): string[] {
  const r = renderXRAudioSettings(model);
  return [...oneStep.effect(r), ...voice.effect(r), ...actionFirst.effect(r), ...plainWords.effect(r), ...gistFirst.effect(r), ...captions.effect(r)];
}

// `wording` adapters work through the prompt — the model was told, which is
// not proof it complied. `voice` adapters are carried out in code on the way
// to the speaker. Captions are absent: they change no spoken line.
export interface AdaptationTag {
  label: string;
  via: 'wording' | 'voice';
}

// Pass the settings the line was spoken with. Baseline speaks with no profile
// and no prompt block, so its caller passes nothing to tag — not render(null),
// whose defaults (clarity 'clear') describe a prompt baseline never gets.
export function adaptationTags(r: XRAudioSettings, opts: { slower?: boolean } = {}): AdaptationTag[] {
  const wording = [...actionFirst.tags(r), ...plainWords.tags(r), ...gistFirst.tags(r)];
  const spoken = [...oneStep.tags(r), ...voice.tags(r, opts)];
  return [
    ...wording.map((label) => ({ label, via: 'wording' as const })),
    ...spoken.map((label) => ({ label, via: 'voice' as const })),
  ];
}
