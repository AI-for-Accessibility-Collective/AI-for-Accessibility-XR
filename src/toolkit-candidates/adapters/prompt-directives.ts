// profilePromptBlock — the INPUT injection (docs/PLAN.md §3.2): the prompt
// halves of the adapters, joined in one block, plus the always-on guard.
//
// In baseline mode the block is simply ABSENT — the model gets the normal
// input. That asymmetry, plus the delivery render on the output side, is the
// toolkit's entire contribution to what the film shows.
//
// Structure only: nothing here changes with speaking rate — Kemper & Harden
// (1999) found the prosodic "adaptations" (slow, high, drawn-out) gave no
// benefit and cancelled the gains from simpler syntax.
//
// PRIVACY FLOOR: model.freeText NEVER reaches the prompt. Only structured
// needs inform these directives (readModel in host.ts already drops freeText
// — this function just never touches it, belt and braces).

import type { AbilityModel } from '@ai4a11y/toolkit';
import type { XRAudioSettings } from '../xr-audio.ts';
import * as oneStep from './one-step.ts';
import * as actionFirst from './action-first.ts';
import * as plainWords from './plain-words.ts';
import * as gistFirst from './gist-first.ts';

// Elderspeak guard: plain words + short steps invite the model to patronise.
// Williams et al. (2009), Kemper & Harden (1999): endearments, diminutives,
// collective 'we', tag questions and sing-song prosody mark elderspeak and
// lower compliance and confidence. Always on; never a setting.
const GUARD =
  "Speak to the wearer as a capable adult: no endearments, no diminutives, no 'we' or 'let's', no tag questions ('okay?'), no sing-song tone, no over-praise, no baby talk.";

export function profilePromptBlock(model: AbilityModel | null, r: XRAudioSettings): string {
  if (!model) return '';
  const lines = [...oneStep.promptLines(r), ...actionFirst.promptLines(r), ...plainWords.promptLines(r), ...gistFirst.promptLines(r)];
  if (!lines.length) return '';
  lines.push(GUARD);
  return 'USER PROFILE (adapt to it):\n' + lines.map((l) => `- ${l}`).join('\n');
}
