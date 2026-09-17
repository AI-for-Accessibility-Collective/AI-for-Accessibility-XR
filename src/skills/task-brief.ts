// task-brief — a model-written brief for any task (docs/DESIGN.md §5.2).
//
// The scripted tasks in src/tasks/*.json carry appliance facts typed from a
// manual. For every other task the SAME kind of brief is written by the
// model, once per request, from the wearer's words and the camera view. The
// prompt that writes it carries no profile, no mode and no delivery
// directive, and the session reuses the brief for every take of that request
// — so baseline and toolkit read identical facts and the film's contrast
// stays what it claims to be: the same content, adapted delivery.

import type { FrameEntry } from '../transport/frames.ts';
import type { VisionClient } from '../engine/vision.ts';
import type { Task } from './types.ts';
import { GENERIC_TASK_ID, genericTask } from './builtin/task-guide.ts';

// A short JSON card plus headroom for Gemini 3.x thought tokens, which bill
// against this budget (engine/gemini-rest.ts).
export const BRIEF_MAX_OUTPUT_TOKENS = 1024;
export const BRIEF_MAX_FACTS = 8;

export const BRIEF_INSTRUCTION =
  'You write the reference card a voice assistant will use to guide a person ' +
  'through a task on their own appliance or object. From their request and ' +
  'the camera view, state the facts the way the appliance manual would: what ' +
  'the appliance or object is, the controls that matter for this task and ' +
  'where they are, and the usual procedure — one fact per line. Describe the ' +
  'controls you can actually see; where the view does not show something, ' +
  'give the normal case for this kind of appliance and mark it "(usually)". ' +
  'Facts only: no steps addressed to the person, nothing about tone, pace or ' +
  'wording. Respond with ONLY compact JSON, no prose and no code fences: ' +
  '{"goal": "<what the person wants to do, in a few words>", ' +
  '"facts": ["<fact>", "<fact>", ...]} with three to eight facts.';

export function briefRequest(request: string): string {
  return `The person said: "${request.replace(/"/g, "'")}". Write the reference card JSON.`;
}

// Tolerate stray prose / code fences: pull the first {...} block and validate.
// null when there is no usable fact list.
export function parseBrief(raw: string, request: string): { goal: string; brief: string[] } | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const brief = (Array.isArray(obj.facts) ? obj.facts : [])
      .filter((f): f is string => typeof f === 'string')
      .map((f) => f.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, BRIEF_MAX_FACTS);
    if (!brief.length) return null;
    const goal =
      typeof obj.goal === 'string' && obj.goal.trim()
        ? obj.goal.replace(/\s+/g, ' ').trim().replace(/[.!?\s]+$/, '').slice(0, 120)
        : genericTask(request).goal;
    return { goal, brief };
  } catch {
    return null;
  }
}

// One model call. Falls back to the request-only task (no facts) when the
// model's answer is unusable, so the guide still runs; a request failure
// propagates for the caller to report.
export async function generateTaskBrief(opts: {
  request: string;
  frames: FrameEntry[];
  vision: VisionClient;
}): Promise<Task> {
  const raw = await opts.vision.generate({
    systemInstruction: BRIEF_INSTRUCTION,
    frames: opts.frames,
    text: briefRequest(opts.request),
    maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS,
    temperature: 0,
  });
  const parsed = parseBrief(raw, opts.request);
  if (!parsed) return genericTask(opts.request);
  return { id: GENERIC_TASK_ID, trigger: [], goal: parsed.goal, brief: parsed.brief };
}
