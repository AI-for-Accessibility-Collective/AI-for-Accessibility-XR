// composePrompt(): what the engine's system instruction is made of, in both
// modes (docs/PLAN.md §2 "compose now assembles: base prompt + task brief +
// (toolkit mode) profile block").
//
// The base persona is deliberately mode-NEUTRAL: no plain-language layer, no
// pacing rules — those arrive ONLY through the profile block, because the
// filmed claim is "unadapted model vs toolkit-adapted", and a baseline that
// was secretly pre-simplified would stage the contrast (§5.2 integrity).

import type { Task } from './types.ts';

export const BASE_PERSONA =
  'You are a voice assistant on camera-equipped smart glasses. You see what ' +
  'the wearer sees and speak to them through the glasses speaker. Help them ' +
  'understand and act in the physical world. This is voice: reply in prose ' +
  'that reads aloud naturally — never lists, headings, or markdown. Never ' +
  'invent details you cannot see; if the view is unclear, say so and ask ' +
  'them to hold steady or move closer. You cannot move or touch anything — ' +
  'you observe and guide.';

export function taskBriefBlock(task: Task): string {
  // No script for this task: the request itself is the brief.
  if (!task.brief.length) {
    return (
      `TASK: The wearer asked: "${task.goal}". No manual is available — guide ` +
      'them through it from what the camera shows and general knowledge of the task.'
    );
  }
  return (
    `TASK: The wearer wants to ${task.goal}. ` +
    'Facts about their appliance (from its manual):\n' +
    task.brief.map((b) => `- ${b}`).join('\n')
  );
}

export function composePrompt(parts: { task?: Task | null; profileBlock?: string; extra?: string[] }): string {
  const out: string[] = [BASE_PERSONA];
  if (parts.task) out.push(taskBriefBlock(parts.task));
  for (const e of parts.extra ?? []) if (e) out.push(e);
  // The toolkit's input injection — '' in baseline mode, and the block sits
  // LAST so its delivery directives take precedence over register habits the
  // brief's manual language invites.
  if (parts.profileBlock) out.push(parts.profileBlock);
  return out.filter(Boolean).join('\n\n');
}
