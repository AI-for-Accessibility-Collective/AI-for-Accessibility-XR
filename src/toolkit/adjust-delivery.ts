// "That was too fast." — the wearer telling the guide, mid-task, how they want
// to be spoken to. The model turns such a remark into one call of the tool
// declared here; this file turns that call into one profile need.
//
// Pure: the tool's declaration, and the mapping from its arguments (plus the
// profile as it stands) to the need to write. Writing it, and re-reading the
// profile, is index.ts's job.
//
// This is an EXPLICIT instruction from the person about themselves, so it is
// written straight to the profile like an edit in the profile editor — not
// proposed and waited on, which is for things an app infers.

import { needSpec } from './needs-catalog.ts';

export const SAID_DURING_TASK_SOURCE = 'said-during-task';

// What the model is offered. One closed vocabulary, in the wearer's terms —
// "slower", not "readAloudRate 0.9" — so the model never invents a value. The
// same three settings as the setup and the editor (needs-catalog.ts), nothing
// the wearer cannot see.
export const ADJUST_DELIVERY_TOOL = {
  name: 'adjust_delivery',
  description:
    'Change how you speak to the wearer, and remember it for next time. Call this ONLY when the wearer comments on the way you are talking to them ' +
    '(your speed, whether you go one step at a time, or wanting your words as text on their phone) — never for anything about the task itself.',
  parameters: {
    type: 'OBJECT',
    properties: {
      change: {
        type: 'STRING',
        enum: ['slower', 'faster', 'one_step_at_a_time', 'everything_at_once', 'captions_on', 'captions_off'],
        description: 'The single change they asked for.',
      },
    },
    required: ['change'],
  },
} as const;

// Added to the system instruction whenever the tool is on offer.
export const ADJUST_DELIVERY_GUIDANCE =
  "If the wearer's CURRENT message comments on HOW you are speaking to them rather than on the task, call adjust_delivery with the one change they want. " +
  'Then, in your reply, say in a few words what you have changed, and give your last instruction again in the new way. Do not apologise at length. ' +
  // Seen in testing: a turn later ("done") the model called it again for the
  // earlier "too fast", hit the limit, and announced its pace out of nowhere.
  'Call it at most once per remark: never for something they said in an earlier turn, and never mention your pace or style unless they have just brought it up.';

export type Adjustment =
  | {
      ok: true;
      key: string;
      value: boolean | string | number;
      // Told back to the model as the tool's result.
      result: string;
      // Kept in the conversation's standing instructions, because a running
      // task's prompt was fixed when it began and would otherwise ignore a
      // change of wording, steps or detail until the next task.
      standing?: string;
    }
  | { ok: false; result: string };

type Needs = ReadonlyArray<{ dimension?: string; value?: unknown }>;

function current(needs: Needs, key: string): unknown {
  return needs.find((n) => n.dimension === key)?.value;
}

export function planAdjustment(args: unknown, needs: Needs): Adjustment {
  const change = (args as { change?: unknown } | null)?.change;
  switch (change) {
    case 'slower':
    case 'faster': {
      const spec = needSpec('readAloudRate')!;
      const min = spec.min ?? 0.7;
      const max = spec.max ?? 1.2;
      const step = spec.step ?? 0.1;
      const now = typeof current(needs, 'readAloudRate') === 'number' ? (current(needs, 'readAloudRate') as number) : Number(spec.default ?? 1);
      const next = Math.round(Math.min(max, Math.max(min, now + (change === 'slower' ? -step : step))) * 10) / 10;
      if (next === now) return { ok: false, result: `Already at the ${change === 'slower' ? 'slowest' : 'fastest'} pace available (${now}×). Tell them so, kindly.` };
      return { ok: true, key: 'readAloudRate', value: next, result: `Done: speaking pace is now ${next}× (was ${now}×), saved to their profile. Your voice is already following it.` };
    }
    case 'one_step_at_a_time':
      return {
        ok: true,
        key: 'pacing',
        value: 'stepwise',
        result: 'Done: one step at a time, saved to their profile.',
        standing: 'From now on give exactly ONE next action, then stop and wait until they tell you, in any words, that it is done.',
      };
    case 'everything_at_once':
      return {
        ok: true,
        key: 'pacing',
        value: 'continuous',
        result: 'Done: the whole walkthrough at once, saved to their profile.',
        standing: 'From now on give the remaining steps together in one answer rather than one at a time.',
      };
    case 'captions_on':
      return { ok: true, key: 'captions', value: true, result: 'Done: your words now also appear as text on their phone, saved to their profile.' };
    case 'captions_off':
      return { ok: true, key: 'captions', value: false, result: 'Done: voice only, no text, saved to their profile.' };
    default:
      return { ok: false, result: 'That is not a change you can make. Carry on with the task.' };
  }
}
