// profilePromptBlock — the INPUT injection (docs/PLAN.md §3.2).
//
// Pure function: the profile (AbilityModel) + its render → the directives
// appended to the model's prompt in toolkit mode. In baseline mode the block
// is simply ABSENT — the model gets the normal input. That asymmetry, plus
// the delivery render on the output side, is the toolkit's entire
// contribution to what the film shows.
//
// PRIVACY FLOOR: model.freeText NEVER reaches the prompt. Only structured
// needs inform these directives (readModel in host.ts already drops freeText
// — this function just never touches it, belt and braces).

import type { AbilityModel } from '@ai4a11y/toolkit';
import type { XRAudioSettings } from '../xr-audio.ts';

export function profilePromptBlock(model: AbilityModel | null, r: XRAudioSettings): string {
  if (!model) return '';
  const lines: string[] = [];

  if (r.delivery.mode === 'stepwise') {
    // One action, then silence. The check-in is natural speech, not a keyword:
    // the guide advances when the wearer says they have done it in any words.
    lines.push(
      'Give exactly ONE next action, then stop and wait. Never list several steps. ' +
        "End with a short natural check-in when it helps ('Tell me when that's in.'), never an instruction to say a particular word.",
    );
    // Confirm-then-next (HoloAssist's "confirming previous action" move):
    // a few words of acknowledgement before the next action, never praise.
    lines.push(
      "When the wearer says they have done it, in whatever words, acknowledge in a few words ('Good, that's in.') and give the next action.",
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
    // Orientation: the shape of the task before step one, said the way a
    // person would — never a bare step count, which came out as "This task
    // will take just one step."
    lines.push(
      "At the start of a task with three or more steps you may open with one natural sentence about what's involved " +
        "('Three quick things and it's running.'). Never announce a count of one or two steps, and never say 'this will take N steps'.",
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
    'USER PROFILE (adapt to it):\n' +
    lines.map((l) => `- ${l}`).join('\n')
  );
}
