// profilePromptBlock — the INPUT injection (docs/PLAN.md §3.2).
//
// Pure function: the granted AbilityModel slice + its render → the directives
// appended to the model's prompt in toolkit mode. In baseline mode the block
// is simply ABSENT — the model gets the normal input. That asymmetry, plus
// the delivery render on the output side, is the toolkit's entire
// contribution to what the film shows.
//
// PRIVACY FLOOR: model.freeText NEVER reaches the prompt. Only granted,
// structured needs inform these directives (and the grant scopes exclude
// freeText anyway — this function just never touches it, belt and braces).

import type { AbilityModel } from '@ai4a11y/toolkit';
import type { AudioRender } from '../audio/render.ts';

export function profilePromptBlock(model: AbilityModel | null, r: AudioRender): string {
  if (!model) return '';
  const lines: string[] = [];

  if (r.delivery.mode === 'stepwise') {
    lines.push(
      "Give exactly ONE next action, then stop and wait for the user to say 'done'. Never list multiple steps.",
    );
    // Confirm-then-next (HoloAssist's "confirming previous action" move):
    // a few words of acknowledgement before the next action, never praise.
    lines.push(
      "When the user says 'done', acknowledge it in a few words (e.g. 'Good, that's done.') and then give the next action.",
    );
  }
  if (r.delivery.maxWordsPerUtterance != null) {
    lines.push(`Keep sentences under ~${r.delivery.maxWordsPerUtterance} words.`);
  }
  if (r.language.simplify) {
    lines.push("Plain everyday words — say 'soap', 'big dial'; no jargon or manual terms.");
  }
  if (r.speech.rate < 1) {
    lines.push('Calm, unhurried phrasing; one short warm confirmation before each step.');
  }
  if (r.delivery.gistFirst) {
    lines.push('Give the one-sentence gist first; details only on request.');
    // Orientation: the shape of the task before step one — the count only,
    // so it never collides with the one-action rule above.
    lines.push(
      'At the start of a task, say in one short sentence roughly how many steps it has (the count only, not the steps) before the first action.',
    );
  }
  if (r.language.readingLevel != null) {
    lines.push(`Aim for a ${r.language.readingLevel} reading level.`);
  }
  if (r.language.language === 'plain') {
    lines.push('Use plain language throughout.');
  }

  if (!lines.length) return '';
  // Elderspeak guard: plain words + calm pacing invite the model to patronise.
  // Slower, simpler delivery must never read as talking down.
  lines.push(
    'Speak to the wearer as a capable adult: no endearments, no sing-song tone, no over-praise, no baby talk.',
  );
  return (
    'USER PROFILE (shared with their consent — adapt to it):\n' +
    lines.map((l) => `- ${l}`).join('\n')
  );
}
