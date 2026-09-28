// Gist-first adapter — carries out `spokenDetail: gist` (or simplify, when
// no detail need is set). Prompt only.

import type { XRAudioSettings } from '../xr-audio.ts';

export function promptLines(r: XRAudioSettings): string[] {
  if (!r.delivery.gistFirst) return [];
  return [
    'Give the one-sentence gist first; details only on request.',
    // Orientation: the shape of the task before step one, said the way a
    // person would — never a bare step count, which came out as "This task
    // will take just one step."
    // (No example sentence: one was given here once and came back verbatim —
    // "Three quick things and it's running" — for charging a pair of earbuds.)
    'At the start of a task with three or more steps you may open with one short sentence, in your own words and about this task, saying roughly what is involved. ' +
      "Never announce a count of one or two steps, and never say 'this will take N steps'.",
  ];
}

export function tags(r: XRAudioSettings): string[] {
  return r.delivery.gistFirst ? ['Gist first'] : [];
}

export function effect(r: XRAudioSettings): string[] {
  return r.delivery.gistFirst ? ['Gist first, details on request'] : [];
}
