// task-brief.test.ts — the model-written brief for a task without a script:
// parsing, the request it makes (no profile, no mode), and its fallback.

import { describe, expect, test } from 'bun:test';
import {
  BRIEF_INSTRUCTION,
  BRIEF_MAX_FACTS,
  BRIEF_MAX_OUTPUT_TOKENS,
  briefRequest,
  generateTaskBrief,
  parseBrief,
} from '../src/skills/task-brief.ts';
import { taskBriefBlock } from '../src/skills/compose.ts';
import type { VisionClient, VisionRequest } from '../src/engine/vision.ts';

const CARD =
  '{"goal": "start the dishwasher on a normal cycle", "facts": ["Front-loading dishwasher.", ' +
  '"Program button on the top edge cycles Eco, Normal, Intensive.", "Start button is the rightmost (usually)."]}';

describe('parseBrief', () => {
  test('a clean card', () => {
    expect(parseBrief(CARD, 'help me start the dishwasher')).toEqual({
      goal: 'start the dishwasher on a normal cycle',
      brief: [
        'Front-loading dishwasher.',
        'Program button on the top edge cycles Eco, Normal, Intensive.',
        'Start button is the rightmost (usually).',
      ],
    });
  });

  test('tolerates prose and code fences around the JSON', () => {
    expect(parseBrief('Here you go:\n```json\n' + CARD + '\n```\n', 'x')?.brief).toHaveLength(3);
  });

  test('drops empty and non-string facts, trims whitespace, caps the count', () => {
    const facts = Array.from({ length: 12 }, (_, i) => `  fact\n ${i}  `);
    const raw = JSON.stringify({ goal: 'g.', facts: ['', null, 3, ...facts] });
    const parsed = parseBrief(raw, 'x')!;
    expect(parsed.brief).toHaveLength(BRIEF_MAX_FACTS);
    expect(parsed.brief[0]).toBe('fact 0');
    expect(parsed.goal).toBe('g');
  });

  test('a missing goal falls back to the request; no facts is no brief', () => {
    expect(parseBrief('{"facts": ["One fact."]}', 'Help me with the kettle!')?.goal).toBe('Help me with the kettle');
    expect(parseBrief('{"goal": "g", "facts": []}', 'x')).toBeNull();
    expect(parseBrief('{"goal": "g"}', 'x')).toBeNull();
    expect(parseBrief('I cannot see an appliance.', 'x')).toBeNull();
    expect(parseBrief('{not json', 'x')).toBeNull();
  });
});

function stubVision(reply: string | Error) {
  const calls: VisionRequest[] = [];
  const vision = {
    generate: async (req: VisionRequest) => {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as VisionClient;
  return { vision, calls };
}

describe('generateTaskBrief', () => {
  const frames = [{ jpeg: Buffer.from('frame'), timestamp: 1 }];

  test('asks once, with the camera frames, at temperature 0, and no profile or delivery words', async () => {
    const { vision, calls } = stubVision(CARD);
    const task = await generateTaskBrief({ request: 'help me start the dishwasher', frames, vision });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      systemInstruction: BRIEF_INSTRUCTION,
      frames,
      text: briefRequest('help me start the dishwasher'),
      maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
    expect(BRIEF_INSTRUCTION + calls[0]!.text).not.toMatch(/profile|one step|slow|plain words|baseline|toolkit/i);
    expect(task).toEqual({
      id: 'general',
      trigger: [],
      goal: 'start the dishwasher on a normal cycle',
      brief: [
        'Front-loading dishwasher.',
        'Program button on the top edge cycles Eco, Normal, Intensive.',
        'Start button is the rightmost (usually).',
      ],
    });
  });

  test('the brief goes into the prompt in the same shape as a scripted one', async () => {
    const { vision } = stubVision(CARD);
    const task = await generateTaskBrief({ request: 'help me start the dishwasher', frames, vision });
    const block = taskBriefBlock(task);
    expect(block).toMatch(/^TASK: The wearer wants to start the dishwasher on a normal cycle\. Facts about their appliance/);
    expect(block).toContain('\n- Program button on the top edge cycles Eco, Normal, Intensive.');
  });

  test('an unusable answer falls back to the request-only task', async () => {
    const { vision } = stubVision('Sorry, I cannot see an appliance in the picture.');
    const task = await generateTaskBrief({ request: 'help me start the dishwasher', frames: [], vision });
    expect(task).toEqual({ id: 'general', trigger: [], goal: 'help me start the dishwasher', brief: [] });
  });

  test('a request failure propagates (the session reports it and falls back)', async () => {
    const { vision } = stubVision(new Error('gemini HTTP 429: quota'));
    await expect(generateTaskBrief({ request: 'help me', frames: [], vision })).rejects.toThrow(/429/);
  });

  test('double quotes in the request cannot break out of the quoted line', () => {
    expect(briefRequest('help me with the "eco" button')).toBe(`The person said: "help me with the 'eco' button". Write the reference card JSON.`);
  });
});
