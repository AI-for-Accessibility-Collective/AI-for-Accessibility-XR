// Action-first adapter — carries out `clarity`: how each step is phrased so
// there is less to hold in mind. Prompt only. Evidence per line; the fuller
// account is docs/design/working-memory-fit.md.

import type { XRAudioSettings } from '../xr-audio.ts';

export function promptLines(r: XRAudioSettings): string[] {
  const lines: string[] = [];
  if (r.language.sentenceWords != null) {
    // Kemper (1987): clause count and clauses BEFORE the main clause predict
    // older adults' recall far better than length; Stine-Morrow: propositional
    // density. So the cap comes with a one-clause rule.
    lines.push(`Keep sentences under ~${r.language.sentenceWords} words, one clause each — no clause before the action.`);
  }
  if (r.language.clarity !== 'standard') {
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
  if (r.language.clarity === 'clearest') {
    // Morrow et al. (1996): schema-ordered instructions improved older adults'
    // recall; Gibson: an already-named thing costs nothing to re-mention.
    lines.push("Say which step this is before each action ('Step 3 of 5.'). Call things by the same name as before: 'that dial'.");
  }
  return lines;
}

export function effect(r: XRAudioSettings): string[] {
  const lines: string[] = [];
  if (r.language.sentenceWords != null) lines.push(`Short sentences (about ${r.language.sentenceWords} words)`);
  if (r.language.clarity !== 'standard') {
    lines.push('Says what to do first, then where');
    lines.push('One new thing per sentence');
    lines.push('Asks a question instead of "if…"');
  }
  if (r.language.clarity === 'clearest') lines.push('Says which step you are on');
  return lines;
}
