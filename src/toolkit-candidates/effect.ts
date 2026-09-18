// effectLines — what the guide will do with a profile, in plain words: each
// adapter describes its own adaptation, in the order the panels show them.

import type { AbilityModel } from '@ai4a11y/toolkit';
import { renderXRAudioSettings } from './xr-audio.ts';
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
