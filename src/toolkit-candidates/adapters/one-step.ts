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
    'Give exactly ONE next action, then stop and wait. Never list several steps. ' +
      "End with a short natural check-in when it helps ('Tell me when that's in.'), never an instruction to say a particular word.",
    // Confirm-then-next (HoloAssist's "confirming previous action" move):
    // a few words of acknowledgement before the next action, never praise.
    "When the wearer says they have done it, in whatever words, acknowledge in a few words ('Good, that's in.') and give the next action.",
  ];
}

// What the person is told this does.
export function effect(r: XRAudioSettings): string[] {
  return [r.delivery.mode === 'stepwise' ? 'One step at a time, then waits for you' : 'Whole answer at once'];
}
