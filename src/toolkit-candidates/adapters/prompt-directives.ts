// profilePromptBlock — the INPUT injection (docs/PLAN.md §3.2).
//
// Pure function: the profile (AbilityModel) + its render → the directives
// appended to the model's prompt in toolkit mode. In baseline mode the block
// is simply ABSENT — the model gets the normal input. That asymmetry, plus
// the delivery render on the output side, is the toolkit's entire
// contribution to what the film shows.
//
// Every directive here is backed by aging / working-memory research (the
// citations sit on each line) and shows up as one plain line in the panels'
// "What the guide will do" (profile-api.ts effectLines), so a person can see
// exactly which behaviours a setting switches on. Structure only: nothing in
// this block changes with speaking rate — Kemper & Harden (1999) found the
// prosodic "adaptations" (slow, high, drawn-out) gave no benefit and cancelled
// the gains from simpler syntax.
//
// PRIVACY FLOOR: model.freeText NEVER reaches the prompt. Only structured
// needs inform these directives (readModel in host.ts already drops freeText
// — this function just never touches it, belt and braces).

import type { AbilityModel } from '@ai4a11y/toolkit';
import type { XRAudioSettings } from '../xr-audio.ts';

export function profilePromptBlock(model: AbilityModel | null, r: XRAudioSettings): string {
  if (!model) return '';
  const lines: string[] = [];
  const clear = r.language.clarity !== 'standard';
  const clearest = r.language.clarity === 'clearest';

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
  if (r.language.sentenceWords != null) {
    // Kemper (1987): clause count and clauses BEFORE the main clause predict
    // older adults' recall far better than length; Stine-Morrow: propositional
    // density. So the cap comes with a one-clause rule.
    lines.push(`Keep sentences under ~${r.language.sentenceWords} words, one clause each — no clause before the action.`);
  }
  if (clear) {
    // Kemper (1987): 60% recall of right-branching vs 22% of left-branching
    // sentences. Dixon, Faries & Gabrys (1988): action-first instructions were
    // read faster on an unfamiliar knob-setting task.
    lines.push("Start with the verb. Where and how come after: 'Turn the dial. It's on the right.'");
    // Gibson (1998): the cost unit is the NEW discourse referent; Cowan (2001):
    // the limit is ~4 items — things, not words.
    lines.push('Introduce at most one new object or value per sentence.');
    // Dixon (1987): conditions before the action slow plan building;
    // Jaroslawska & Gathercole (2018): accuracy falls with each instruction
    // held before acting. Ask, then wait, instead of branching.
    lines.push("Never say 'if' or 'when'. Ask a yes/no question and wait: 'Is the light green?'");
  }
  if (clearest) {
    // Morrow et al. (1996): schema-ordered instructions improved older adults'
    // recall; Gibson: an already-named thing costs nothing to re-mention.
    lines.push("Say which step this is before each action ('Step 3 of 5.'). Call things by the same name as before: 'that dial'.");
  }
  if (r.language.simplify) {
    lines.push("Plain everyday words — say 'soap', 'big dial'; not manual terms, never jargon, never technical terms.");
    // Lewis & Vasishth (2005): similar competing items interfere at retrieval
    // — 'the dial' and 'the knob' for one object is a cost.
    lines.push('Use one name per object for the whole task.');
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

  if (!lines.length) return '';
  // Elderspeak guard: plain words + short steps invite the model to patronise.
  // Williams et al. (2009), Kemper & Harden (1999): endearments, diminutives,
  // collective 'we', tag questions and sing-song prosody mark elderspeak and
  // lower compliance and confidence. Always on; never a setting.
  lines.push(
    "Speak to the wearer as a capable adult: no endearments, no diminutives, no 'we' or 'let's', no tag questions ('okay?'), no sing-song tone, no over-praise, no baby talk.",
  );
  return (
    'USER PROFILE (adapt to it):\n' +
    lines.map((l) => `- ${l}`).join('\n')
  );
}
