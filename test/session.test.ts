// session.test.ts — the session state machine on a real toolkit store with a
// stubbed engine and instant speech: Toolkit mode adapting straight away,
// mode switches, repeat, in-flight replies, engine failures, and routing.
// Each test is shaped to fail if the fix it names is reverted.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type Session, type SessionEvent } from '../src/runtime/session.ts';
import { createSpeaker } from '../src/audio/speaker.ts';
import { bootToolkit } from '../src/toolkit/host.ts';
import { FrameStore } from '../src/transport/frames.ts';
import type { TurnEngine } from '../src/engine/engine.ts';
import type { VisionRequest } from '../src/engine/vision.ts';
import type { Task } from '../src/skills/types.ts';
import { taskBriefBlock } from '../src/skills/compose.ts';
import { BRIEF_INSTRUCTION, parseBrief } from '../src/skills/task-brief.ts';
import washingMachine from '../src/tasks/washing-machine.json';
import bill from '../src/tasks/bill.json';
import fixture from './fixtures/margaret.blob.json';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await Bun.sleep(5);
  }
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

interface RigOpts {
  replies?: string[];
  engineError?: Error;
  failOnTurn?: number; // 1-based turn number that throws
  holdFirstTurn?: Promise<void>; // the first engine turn waits for this
  vision?: { generate: (req: unknown) => Promise<string> };
  tasks?: Task[];
}

async function rig(opts: RigOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wearable-ext-session-'));
  dirs.push(dir);
  const spoken: string[] = [];
  const events: SessionEvent[] = [];
  const turns: string[] = [];
  const instructions: string[] = []; // system instruction of each engine made
  const framesUsed: Array<{ what: string; jpegs: string[] }> = []; // what the debug view is told

  const tk = await bootToolkit({ dataDir: dir, actingUser: 'margaret' });
  await tk.librarian.importProfileBlob(fixture as never);

  const speaker = createSpeaker({ speak: async (t) => void spoken.push(t) }, undefined, {
    sleep: async () => {},
  });
  let n = 0;
  const makeEngine = (si: string): TurnEngine => ({
    turn: async (text) => {
      if (!instructions.includes(si)) instructions.push(si);
      turns.push(text);
      const turnNumber = turns.length;
      if (turnNumber === 1 && opts.holdFirstTurn) await opts.holdFirstTurn;
      if (opts.engineError || opts.failOnTurn === turnNumber) throw opts.engineError ?? new Error('gemini m HTTP 429: quota');
      const replies = opts.replies ?? ['Open the drawer.'];
      return replies[Math.min(n++, replies.length - 1)]!;
    },
    reset() {},
  });
  const frames = new FrameStore(3);
  const session: Session = createSession({
    frames,
    speaker,
    makeEngine,
    tk,
    panel: { emit: (e) => void events.push(e) },
    tasks: opts.tasks ?? [washingMachine as Task],
    vision: (opts.vision ?? null) as never,
    initialMode: 'baseline',
    onFramesUsed: (what, used) => void framesUsed.push({ what, jpegs: used.map((f) => String(f.jpeg)) }),
  });
  return { session, tk, spoken, events, turns, instructions, frames, framesUsed };
}

const taskStatus = (r: Awaited<ReturnType<typeof rig>>) =>
  r.events.find((e) => e.type === 'status' && e.text.startsWith('Task:'))?.text;

describe('choosing Toolkit mode', () => {
  test('adapts straight away: no question is spoken, nothing waits for an answer', async () => {
    const r = await rig();
    await r.session.setMode('toolkit');
    const st = r.session.state();
    expect(st).toMatchObject({ mode: 'toolkit', profileOn: true, rate: 0.8, deliveryMode: 'stepwise', captionsMirror: true, switching: false });
    expect(st.needs.map((n) => n.dimension).sort()).toEqual(['captions', 'clarity', 'pacing', 'readAloudRate', 'simplify']);
    expect(r.spoken).toEqual([]);
    expect(r.events.filter((e) => e.type !== 'status')).toEqual([]);
  });

  test('the panels are told as it happens: the read starting, then the profile in use — and baseline as none', async () => {
    const r = await rig();
    await r.session.setMode('toolkit');
    expect(r.events.map((e) => e.toolkit).filter(Boolean)).toEqual(['reading', 'loaded']);
    await r.session.refreshProfile();
    expect(r.events.at(-1)?.toolkit).toBe('updated');
    await r.session.setMode('baseline');
    expect(r.events.at(-1)?.toolkit).toBe('none');
  });

  test('works while paused (the mode chosen at boot, before Start)', async () => {
    const r = await rig();
    r.session.setPaused(true);
    await r.session.setMode('toolkit');
    expect(r.session.state().profileOn).toBe(true);
  });

  test('"yes" and "okay" are ordinary words now — they go to the guide like anything else', async () => {
    const r = await rig({ replies: ['Happy to help.'] });
    await r.session.setMode('toolkit');
    await r.session.onUtterance('yes');
    expect(r.turns).toEqual(['yes']);
  });

  test('baseline is unchanged: defaults, no profile, no profile block in the prompt', async () => {
    const r = await rig({ replies: ['Open the drawer.'] });
    await r.session.setMode('baseline');
    expect(r.session.state()).toMatchObject({ mode: 'baseline', profileOn: false, needs: [], rate: 1, deliveryMode: 'continuous', captionsMirror: false });
    await r.session.onUtterance('help me start the washing machine');
    expect(taskStatus(r)).toMatch(/full walkthrough/);
    expect(r.instructions.at(-1)).not.toContain('USER PROFILE');
  });

  test('switching back to baseline drops the profile', async () => {
    const r = await rig();
    await r.session.setMode('toolkit');
    await r.session.setMode('baseline');
    expect(r.session.state()).toMatchObject({ mode: 'baseline', profileOn: false, needs: [], rate: 1 });
  });

  test('an empty store runs toolkit mode with defaults and says so', async () => {
    const r = await rig();
    r.tk.librarian.getAbilityModel = async () => ({ schemaVersion: 1, supportAreas: [], freeText: '', language: 'standard', readingLevel: null, confidence: null, needs: [] });
    await r.session.setMode('toolkit');
    expect(r.session.state()).toMatchObject({ mode: 'toolkit', profileOn: false, rate: 1 });
    expect(r.events.at(-1)?.text).toMatch(/no profile in the store/);
  });

  test("the person's free text reaches neither the prompt nor the panel state", async () => {
    const r = await rig({ replies: ['Open the drawer.', 'A kettle.'] });
    await r.tk.librarian.setProfileField('freeText', 'PRIVATE-NOTE my hands shake in the morning');
    await r.session.setMode('toolkit');
    await r.session.onUtterance('help me start the washing machine');
    await r.session.onUtterance('stop');
    await r.session.onUtterance('what is in front of me');
    expect(r.instructions.length).toBeGreaterThanOrEqual(2);
    for (const si of r.instructions) {
      expect(si).toContain('USER PROFILE');
      expect(si).not.toMatch(/PRIVATE-NOTE|hands shake/);
    }
    expect(JSON.stringify(r.session.state())).not.toMatch(/PRIVATE-NOTE|hands shake/);
    expect(JSON.stringify(r.events)).not.toMatch(/PRIVATE-NOTE|hands shake/);
  });
});

describe('a toggle while a switch is still running', () => {
  test('is not lost: the latest request is applied before setMode resolves', async () => {
    const r = await rig();
    const hold = gate();
    let reading = false;
    const realRead = r.tk.librarian.getAbilityModel.bind(r.tk.librarian);
    r.tk.librarian.getAbilityModel = async () => {
      reading = true;
      await hold.opened;
      return realRead();
    };
    const toToolkit = r.session.setMode('toolkit');
    await waitFor(() => reading);
    expect(r.session.state().switching).toBe(true);
    const toBaseline = r.session.setMode('baseline');
    hold.open();
    await Promise.all([toToolkit, toBaseline]);
    expect(r.session.state()).toMatchObject({ mode: 'baseline', profileOn: false, rate: 1, switching: false });
  });

  test('a failed profile read never rejects — the mode runs with defaults', async () => {
    const r = await rig();
    r.tk.librarian.getAbilityModel = async () => {
      throw new Error('store unreadable');
    };
    await expect(r.session.setMode('toolkit')).resolves.toBeUndefined();
    expect(r.session.state()).toMatchObject({ mode: 'toolkit', profileOn: false, switching: false });
    expect(r.events.at(-1)?.text).toMatch(/Mode switch failed.*store unreadable/);
  });
});

describe('repeat', () => {
  test('replays the step word for word, as often as asked, and never suggests anything', async () => {
    const r = await rig({ replies: ['Open the drawer.', 'Put the soap in the big slot.'] });
    await r.session.setMode('toolkit');
    await r.session.onUtterance('help me start the washing machine');
    await r.session.onUtterance('done');
    const before = await r.tk.librarian.getAbilityModel();
    for (let i = 0; i < 3; i++) await r.session.onUtterance('repeat');
    await Bun.sleep(20); // anything a repeat might have kicked off would land here
    expect(r.spoken).toEqual(['Open the drawer.', ...Array(4).fill('Put the soap in the big slot.')]);
    expect(r.turns).toEqual(['help me start the washing machine', "Done. What's the next step?"]); // no model call for a repeat
    expect(r.events.filter((e) => e.type === 'assistant' || e.type === 'hud')).toEqual([]);
    expect(r.session.state().rate).toBe(0.8);
    expect(await r.tk.librarian.getAbilityModel()).toEqual(before); // the profile is never written
    await r.session.onUtterance('done');
    expect(r.turns.at(-1)).toBe("Done. What's the next step?");
  });

  test('a mode switch clears the repeat memory', async () => {
    const r = await rig({ replies: ['A kettle.'] });
    await r.session.onUtterance('what is in front of me');
    await r.session.setMode('toolkit');
    await r.session.onUtterance('repeat');
    expect(r.spoken).toEqual(['A kettle.']);
    expect(r.events.at(-1)?.text).toBe('Nothing to repeat yet');
  });
});

describe('in-flight replies and failures', () => {
  test('an engine failure never rejects — it reports and apologizes', async () => {
    const r = await rig({ engineError: new Error('gemini m HTTP 429: quota exhausted') });
    await expect(r.session.onUtterance('what is in front of me')).resolves.toBeUndefined();
    await expect(r.session.onUtterance('help me start the washing machine')).resolves.toBeUndefined();
    expect(r.events.some((e) => e.type === 'status' && /Guide error — gemini m HTTP 429/.test(e.text))).toBe(true);
    expect(r.spoken.at(-1)).toMatch(/^Sorry/);
  });

  test('the apology is never what "repeat" replays', async () => {
    const r = await rig({ replies: ['There is a washing machine in front of you.'], failOnTurn: 2 });
    await r.session.onUtterance('what is in front of me');
    await r.session.onUtterance('tell me more');
    expect(r.spoken.at(-1)).toMatch(/^Sorry/);
    await r.session.onUtterance('repeat');
    expect(r.spoken.at(-1)).toBe('There is a washing machine in front of you.');
  });

  test('a reply still being written when the mode changes is never spoken', async () => {
    const hold = gate();
    const r = await rig({ replies: ['An old baseline answer.'], holdFirstTurn: hold.opened });
    const pending = r.session.onUtterance('what is in front of me');
    await waitFor(() => r.turns.length === 1);
    await r.session.setMode('baseline');
    hold.open();
    await pending;
    expect(r.spoken).not.toContain('An old baseline answer.');
  });

  test('"stop" while a step is being written: the step is never spoken', async () => {
    const hold = gate();
    const r = await rig({ replies: ['Open the drawer.'], holdFirstTurn: hold.opened });
    const pending = r.session.onUtterance('help me start the washing machine');
    await waitFor(() => r.turns.length === 1);
    await r.session.onUtterance('stop');
    hold.open();
    await pending;
    expect(r.spoken).not.toContain('Open the drawer.');
  });
});

describe('routing', () => {
  const billVision = { generate: async () => '{"text": "AMOUNT DUE: $42.17", "sizePct": 8, "kind": "bill"}' };

  for (const ask of ['what does this say?', 'what does this letter say?', 'can you read my bill?']) {
    test(`"${ask}" reads the page instead of starting the bill task`, async () => {
      const r = await rig({ vision: billVision, tasks: [washingMachine as Task, bill as Task] });
      setTimeout(() => {
        r.frames.push(Buffer.from('frame-one-bytes'));
        r.frames.push(Buffer.from('frame-two-bytes'));
      }, 5);
      await r.session.onUtterance(ask);
      expect(r.spoken.at(-1)).toBe('It says: AMOUNT DUE: $42.17');
      expect(r.events.some((e) => e.type === 'status' && e.text.startsWith('Task:'))).toBe(false);
    });
  }

  test('a plain question is a conversation turn, not a task', async () => {
    const r = await rig({ replies: ['A kettle.'] });
    await r.session.onUtterance('what is in front of me');
    expect(r.session.state().task).toBeNull();
    expect(r.events.some((e) => e.type === 'status' && e.text.startsWith('Task:'))).toBe(false);
    expect(r.instructions.at(-1)).not.toMatch(/^TASK:|\nTASK:/);
  });
});

describe('the frames the debug view is shown', () => {
  test('a conversation turn reports the whole ring, oldest first — the frames the model gets', async () => {
    const r = await rig({ replies: ['A kettle.'] });
    for (const f of ['one', 'two', 'three', 'four']) r.frames.push(Buffer.from(`frame-${f}`));
    await r.session.onUtterance('what is in front of me');
    expect(r.framesUsed).toEqual([{ what: 'Answering', jpegs: ['frame-two', 'frame-three', 'frame-four'] }]);
  });

  test('a read reports the fresh frames it waited for, not the ring', async () => {
    const r = await rig({ vision: { generate: async () => '{"text": "AMOUNT DUE", "sizePct": 8, "kind": "bill"}' } });
    r.frames.push(Buffer.from('stale'));
    setTimeout(() => {
      r.frames.push(Buffer.from('fresh-one'));
      r.frames.push(Buffer.from('fresh-two'));
    }, 5);
    await r.session.onUtterance('what does this say?');
    expect(r.framesUsed).toEqual([{ what: 'Reading text', jpegs: ['fresh-one', 'fresh-two'] }]);
  });

  test('no camera: an empty list is still reported, so the view can say the model saw nothing', async () => {
    const r = await rig({ replies: ['I cannot see anything.'] });
    await r.session.onUtterance('what is in front of me');
    expect(r.framesUsed).toEqual([{ what: 'Answering', jpegs: [] }]);
  });
});

describe('tasks without a script (no camera client: the request is the brief)', () => {
  test('"help me start the dishwasher" runs the guide with the request as its brief, not the washing-machine manual', async () => {
    const r = await rig({ replies: ['Open the door.'], tasks: [washingMachine as Task, bill as Task] });
    await r.session.onUtterance('help me start the dishwasher');
    expect(taskStatus(r)).toMatch(/^Task: help me start the dishwasher · full walkthrough/);
    expect(r.session.state().task).toMatchObject({ id: 'general', active: true, stepCount: 1 });
    expect(r.instructions.at(-1)).toContain('The wearer asked: "help me start the dishwasher"');
    expect(r.instructions.at(-1)).not.toMatch(/Dispenser drawer|from its manual/);
    expect(r.spoken.at(-1)).toBe('Open the door.');
  });

  test('in toolkit mode "done" advances it with the same fixed prompt as a scripted task', async () => {
    const r = await rig({ replies: ['Open the door.', 'Slide the rack out.'] });
    await r.session.setMode('toolkit');
    await r.session.onUtterance('help me set the microwave clock');
    expect(taskStatus(r)).toMatch(/^Task: help me set the microwave clock · one step at a time/);
    await r.session.onUtterance('done');
    expect(r.turns).toEqual(['help me set the microwave clock', "Done. What's the next step?"]);
    expect(r.spoken.at(-1)).toBe('Slide the rack out.');
    expect(r.session.state().task?.stepCount).toBe(2);
    expect(r.instructions.at(-1)).toContain('USER PROFILE');
  });

  test('a scripted request while an unscripted task runs switches to the script', async () => {
    const r = await rig({ replies: ['Open the door.', 'Open the drawer.'] });
    await r.session.onUtterance('help me start the dishwasher');
    await r.session.onUtterance('actually, help me start the washing machine');
    expect(r.session.state().task?.id).toBe('washing-machine');
    expect(r.instructions.at(-1)).toContain('Dispenser drawer');
    expect(r.spoken.at(-1)).toBe('Open the drawer.');
  });

  test('"stop" ends it like any task', async () => {
    const r = await rig({ replies: ['Open the door.'] });
    await r.session.onUtterance('help me start the dishwasher');
    await r.session.onUtterance('stop');
    expect(r.session.state().task).toBeNull();
  });
});

describe('the brief a model writes for a task without a script', () => {
  const CARD =
    '{"goal": "start the dishwasher on a normal cycle", "facts": ["Front-loading dishwasher.", ' +
    '"Program button on the top edge cycles Eco, Normal, Intensive.", "Start button is the rightmost (usually)."]}';
  const cardTask = { id: 'general', trigger: [], ...parseBrief(CARD, 'x')! };

  // Answers brief requests only; anything else (a camera check) is 'unclear'.
  function briefVision(reply: string | Error | Promise<string>) {
    const calls: VisionRequest[] = [];
    return {
      calls,
      generate: async (req: unknown) => {
        const v = req as VisionRequest;
        if (v.systemInstruction !== BRIEF_INSTRUCTION) return 'unclear';
        calls.push(v);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
  }

  test('the facts land in the guide prompt, the goal in the status, the brief in the log', async () => {
    const v = briefVision(CARD);
    const r = await rig({ replies: ['Open the door.'], vision: v });
    r.frames.push(Buffer.from('a-frame'));
    await r.session.onUtterance('help me start the dishwasher');
    expect(v.calls).toHaveLength(1);
    expect(v.calls[0]!.frames).toHaveLength(1);
    expect(taskStatus(r)).toMatch(/^Task: start the dishwasher on a normal cycle · full walkthrough/);
    expect(r.instructions.at(-1)).toContain(taskBriefBlock(cardTask));
    expect(r.events.some((e) => e.type === 'status' && /Brief written by the model/.test(e.text) && /Eco, Normal, Intensive/.test(e.text))).toBe(true);
    expect(r.spoken.at(-1)).toBe('Open the door.');
  });

  test('one request, two takes, one brief: baseline and toolkit read identical facts', async () => {
    const v = briefVision(CARD);
    const r = await rig({ replies: ['Open the door.'], vision: v });
    await r.session.onUtterance('Help me start the dishwasher!');
    const baseline = r.instructions.at(-1)!;
    await r.session.setMode('toolkit');
    await r.session.onUtterance('help me start the dishwasher');
    const toolkit = r.instructions.at(-1)!;
    expect(v.calls).toHaveLength(1); // written once, reused for the second take
    expect(baseline).toContain(taskBriefBlock(cardTask));
    expect(toolkit).toContain(taskBriefBlock(cardTask));
    expect(baseline).not.toContain('USER PROFILE');
    expect(toolkit).toContain('USER PROFILE');
    expect(toolkit.indexOf(taskBriefBlock(cardTask))).toBeLessThan(toolkit.indexOf('USER PROFILE'));
  });

  test('when the brief cannot be written the guide still runs from the request, and asks again next time', async () => {
    const v = briefVision(new Error('gemini m HTTP 429: quota'));
    const r = await rig({ replies: ['Open the door.'], vision: v });
    await r.session.onUtterance('help me start the dishwasher');
    expect(r.events.some((e) => e.type === 'status' && /Could not write a brief \(gemini m HTTP 429/.test(e.text))).toBe(true);
    expect(r.instructions.at(-1)).toContain('The wearer asked: "help me start the dishwasher"');
    expect(r.spoken.at(-1)).toBe('Open the door.');
    await r.session.onUtterance('stop');
    await r.session.onUtterance('help me start the dishwasher');
    expect(v.calls).toHaveLength(2);
  });

  test('the washing-machine script never asks for a brief', async () => {
    const v = briefVision(CARD);
    const r = await rig({ replies: ['Open the drawer.'], vision: v });
    await r.session.onUtterance('help me start the washing machine');
    expect(v.calls).toHaveLength(0);
    expect(r.instructions.at(-1)).toContain('Dispenser drawer');
  });

  test('a mode change while the brief is being written drops that task', async () => {
    const hold = gate();
    const v = briefVision(hold.opened.then(() => CARD));
    const r = await rig({ replies: ['Open the door.'], vision: v });
    const pending = r.session.onUtterance('help me start the dishwasher');
    await waitFor(() => v.calls.length === 1);
    await r.session.setMode('baseline');
    hold.open();
    await pending;
    expect(r.session.state().task).toBeNull();
    expect(r.turns).toHaveLength(0);
    expect(r.spoken).not.toContain('Open the door.');
  });
});
