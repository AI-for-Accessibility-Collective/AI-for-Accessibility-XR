// task-guide.test.ts — stubbed engine: one-step turn requests in stepwise,
// single full turn in continuous; done/stop; verify yes/no/unclear/timeout;
// trigger match. Asserts the turn requests + gating, never the model's prose.

import { describe, expect, test } from 'bun:test';
import { createTaskGuide, parseVerifyAnswer, verifyQuestion, type VerifyResult } from '../src/skills/builtin/task-guide.ts';
import { matchesTask, type Task } from '../src/skills/types.ts';
import washingMachine from '../src/tasks/washing-machine.json';

const TASK = washingMachine as Task;

describe('verify answer parsing', () => {
  test('yes / no with punctuation and trailing words', () => {
    expect(parseVerifyAnswer('Yes.')).toBe('yes');
    expect(parseVerifyAnswer('  yes, it is on Cottons')).toBe('yes');
    expect(parseVerifyAnswer('No')).toBe('no');
    expect(parseVerifyAnswer('No, it points at Synthetics.')).toBe('no');
  });
  test('words that merely START with yes/no are not answers', () => {
    expect(parseVerifyAnswer('Not sure')).toBe('unclear');
    expect(parseVerifyAnswer('None of the labels are visible')).toBe('unclear');
    expect(parseVerifyAnswer('Yesterday')).toBe('unclear');
  });
  test('empty / unclear', () => {
    expect(parseVerifyAnswer('')).toBe('unclear');
    expect(parseVerifyAnswer('Unclear')).toBe('unclear');
  });
  test('the question asks for exactly one word', () => {
    expect(verifyQuestion(TASK.verify![0]!.prompt)).toMatch(/Cottons.*exactly one word: yes, no, or unclear\.$/);
  });
});

function harness(opts: {
  mode: 'stepwise' | 'continuous';
  replies: string[];
  verify?: (prompt: string) => Promise<VerifyResult>;
}) {
  const turns: string[] = [];
  const said: Array<{ text: string; stepId?: string }> = [];
  let i = 0;
  const guide = createTaskGuide({
    task: TASK,
    mode: opts.mode,
    engine: {
      turn: async (text) => {
        turns.push(text);
        return opts.replies[Math.min(i++, opts.replies.length - 1)]!;
      },
    },
    verify: opts.verify,
    say: async (text, o) => void said.push({ text, stepId: o?.stepId }),
    verifyTimeoutMs: 50,
  });
  return { guide, turns, said };
}

describe('trigger match', () => {
  test('matches the film line', () => {
    expect(matchesTask(TASK, 'Can you help me start the washing machine?')).toBe(true);
  });
  test('does not match unrelated talk', () => {
    expect(matchesTask(TASK, 'what is the weather today')).toBe(false);
  });
});

describe('stepwise mode', () => {
  test("start sends the user's own words; done sends the advance prompt; each reply spoken with a step id", async () => {
    const { guide, turns, said } = harness({
      mode: 'stepwise',
      replies: ['First, open the soap drawer.', 'Now turn the dial to Cottons.', "All done — it's running."],
    });
    await guide.start('help me start the washing machine');
    expect(turns).toEqual(['help me start the washing machine']);
    expect(said).toEqual([{ text: 'First, open the soap drawer.', stepId: 'step-1' }]);
    expect(guide.active).toBe(true);

    await guide.advance();
    expect(turns[1]).toBe("Done. What's the next step?");
    expect(said[1]).toEqual({ text: 'Now turn the dial to Cottons.', stepId: 'step-2' });

    await guide.advance();
    expect(guide.active).toBe(false); // completion phrase detected
    expect(guide.stepCount).toBe(3);
  });

  test('a mid-task question goes to the engine without advancing the done flow', async () => {
    const { guide, turns } = harness({
      mode: 'stepwise',
      replies: ['Open the drawer.', 'The soap goes in the left section.'],
    });
    await guide.start('help me with the washing machine');
    await guide.ask('which hole does the soap go in?');
    expect(turns).toEqual(['help me with the washing machine', 'which hole does the soap go in?']);
  });

  test('stop deactivates without another turn', async () => {
    const { guide, turns } = harness({ mode: 'stepwise', replies: ['Open the drawer.'] });
    await guide.start('washing machine please');
    guide.stop();
    expect(guide.active).toBe(false);
    await guide.advance();
    expect(turns).toHaveLength(1); // no further engine calls
  });
});

describe('continuous mode (baseline)', () => {
  test("ONE full turn; 'done' never advances; follow-up questions stay in the same conversation", async () => {
    const { guide, turns, said } = harness({
      mode: 'continuous',
      replies: [
        'Add detergent to compartment II, set the program selector to Cottons, confirm 40 degrees, and press Start for two seconds.',
        'Compartment II is the largest one, on the left.',
      ],
    });
    await guide.start('how do I start a cottons wash?');
    expect(turns).toHaveLength(1);
    expect(said).toHaveLength(1);
    await guide.advance(); // done-gating is a stepwise feature only
    expect(turns).toHaveLength(1);
    // The guide stays active so a follow-up keeps the task brief + history.
    expect(guide.active).toBe(true);
    await guide.ask('which one is compartment two?');
    expect(turns[1]).toBe('which one is compartment two?');
    expect(said).toHaveLength(2);
  });
});

describe('finishing', () => {
  test('continuous mode stays open after a full answer that ends "you are all set"', async () => {
    const { guide, turns } = harness({
      mode: 'continuous',
      replies: ['Put soap in compartment II, turn the dial to Cottons, set 40, then hold Start. That is everything, you are all set!', 'The left one.'],
    });
    await guide.start('how do I start a cottons wash?');
    expect(guide.active).toBe(true);
    await guide.ask('which compartment again?');
    expect(turns).toHaveLength(2);
  });

  test('stopped while the model is still writing a step: that step is never spoken', async () => {
    let release!: (v: string) => void;
    const said: string[] = [];
    const guide = createTaskGuide({
      task: TASK,
      mode: 'stepwise',
      engine: { turn: () => new Promise<string>((r) => (release = r)) },
      say: async (text) => void said.push(text),
    });
    const starting = guide.start('washing machine');
    guide.stop();
    release('Open the drawer.');
    await starting;
    expect(said).toHaveLength(0);
  });

  test('a camera confirmation is spoken without becoming the repeat target', async () => {
    const opts: Array<{ text: string; remember?: boolean }> = [];
    const guide = createTaskGuide({
      task: TASK,
      mode: 'stepwise',
      engine: { turn: async () => 'Turn the big dial to Cottons.' },
      verify: async () => 'yes',
      say: async (text, o) => void opts.push({ text, remember: o?.remember }),
    });
    await guide.start('washing machine');
    expect(opts.at(-1)).toEqual({ text: "I can see it's on Cottons. Good.", remember: false });
    expect(opts[0]!.remember).toBeUndefined();
  });
});

describe('verification (docs/DESIGN.md §4 camera beat)', () => {
  const dialReply = 'Now turn the big dial until the marker points at Cottons.';

  test("engine reply mentioning 'dial' triggers ONE verify; yes → sayOnYes spoken", async () => {
    const prompts: string[] = [];
    const { guide, said } = harness({
      mode: 'stepwise',
      replies: [dialReply, 'Good. Now check the dial once more.'],
      verify: async (p) => {
        prompts.push(p);
        return 'yes';
      },
    });
    await guide.start('washing machine');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Cottons');
    expect(said.map((s) => s.text)).toContain("I can see it's on Cottons. Good.");
    // The spec is consumed: a second dial mention verifies nothing.
    await guide.advance();
    expect(prompts).toHaveLength(1);
  });

  test('no → silent', async () => {
    const { guide, said } = harness({ mode: 'stepwise', replies: [dialReply], verify: async () => 'no' });
    await guide.start('washing machine');
    expect(said.map((s) => s.text)).not.toContain("I can see it's on Cottons. Good.");
  });

  test('unclear → silent', async () => {
    const { guide, said } = harness({ mode: 'stepwise', replies: [dialReply], verify: async () => 'unclear' });
    await guide.start('washing machine');
    expect(said).toHaveLength(1);
  });

  test('hung verify times out silently and never blocks the flow', async () => {
    const { guide, said } = harness({
      mode: 'stepwise',
      replies: [dialReply],
      verify: () => new Promise<VerifyResult>(() => {}), // never resolves
    });
    await guide.start('washing machine'); // resolves despite the hang (50ms timeout)
    expect(said).toHaveLength(1);
  });

  test('verify error → silent', async () => {
    const { guide, said } = harness({
      mode: 'stepwise',
      replies: [dialReply],
      verify: async () => {
        throw new Error('camera gone');
      },
    });
    await guide.start('washing machine');
    expect(said).toHaveLength(1);
  });

  test('no verify hook (no camera) → step still spoken', async () => {
    const { guide, said } = harness({ mode: 'stepwise', replies: [dialReply] });
    await guide.start('washing machine');
    expect(said).toHaveLength(1);
  });
});
