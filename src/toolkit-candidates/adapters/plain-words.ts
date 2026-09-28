// Plain-words adapter — carries out `simplify`. Prompt only.

import type { XRAudioSettings } from '../xr-audio.ts';

export function promptLines(r: XRAudioSettings): string[] {
  if (!r.language.simplify) return [];
  return [
    "Plain everyday words — say 'soap', 'big dial'; not manual terms, never jargon, never technical terms.",
    // Lewis & Vasishth (2005): similar competing items interfere at retrieval
    // — 'the dial' and 'the knob' for one object is a cost.
    'Use one name per object for the whole task.',
  ];
}

export function tags(r: XRAudioSettings): string[] {
  return r.language.simplify ? ['Plain words'] : [];
}

export function effect(r: XRAudioSettings): string[] {
  return r.language.simplify ? ['Plain everyday words, never jargon', 'The same word for the same thing'] : [];
}
