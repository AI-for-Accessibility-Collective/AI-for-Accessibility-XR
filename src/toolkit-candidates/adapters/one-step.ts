// One-step adapter — carries out `pacing: stepwise`: one action, then the
// guide waits for the person. Its prompt half is here; its delivery half
// (short chunks with a pause between them) is paced-delivery.ts, which the
// speaker calls with these same settings.

import type { XRAudioSettings } from '../xr-audio.ts';

export function promptLines(r: XRAudioSettings): string[] {
  if (r.delivery.mode !== 'stepwise') return [];
  return [
    // One action, then silence. The check-in is natural speech, not a keyword:
    // the guide advances when the wearer says they have done it in any words.
    // No quotable example phrases here: the model repeats them word for word
    // ("Tell me when that's in" after "find the case").
    'Give exactly ONE next action, then stop and wait. Never list several steps. ' +
      'You may end with a few words asking them to tell you when it is done, worded to fit that action; never instruct them to say a particular word.',
    // Confirm-then-next (HoloAssist's "confirming previous action" move):
    // a few words of acknowledgement before the next action, never praise.
    // Worded as what to SAY, not as a stage direction: "acknowledge … then give
    // the next action" came back spoken aloud as "Acknowledge: You have opened
    // the drawer."
    'When the wearer says they have done it, in whatever words, begin your reply with a few plain words naming what they just did, then give the next action. ' +
      'Everything you write is spoken aloud exactly as written: never write labels, headings or stage directions.',
    // Continuity: a question or a wrong object mid-step is a moment to help,
    // not to start the step over. Re-reading the step verbatim after "no,
    // that's your phone" is what made the guide feel stuck.
    'If they ask something or show you the wrong thing partway through a step, answer that directly and help from where they are: ' +
      'say what you can see, and guide them to the right thing using the view (where it is, what it looks like, what it is next to). ' +
      'Do not read the step out again word for word or restate its number; carry on the conversation. ' +
      'If the same step has failed twice, try a different way of describing it.',
  ];
}

// Its short name, for a panel that shows what shaped a spoken line.
export function tags(r: XRAudioSettings): string[] {
  return r.delivery.mode === 'stepwise' ? ['One step at a time'] : [];
}

// What the person is told this does.
export function effect(r: XRAudioSettings): string[] {
  return [r.delivery.mode === 'stepwise' ? 'One step at a time, then waits for you' : 'Whole answer at once'];
}
