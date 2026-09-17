// session.test.ts — the session state machine on a real toolkit store with a
// stubbed engine and instant speech: every way a consent answer can arrive,
// mode switches during the question, in-flight replies, engine failures, and
// routing. Each test is shaped to fail if the fix it names is reverted.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type Session, type SessionEvent } from '../src/runtime/session.ts';
import { createSpeaker } from '../src/audio/speaker.ts';
import { bootToolkit } from '../src/toolkit/host.ts';
import { audioConsent, parseBareConsentAnswer } from '../src/toolkit/consent-audio.ts';
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
  answerTimeoutMs?: number;
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
  const onSpeak: Array<(text: string) => Promise<void> | void> = [];
  let listening = false;
  let session: Session | null = null;

  const speakLine = async (text: string) => {
    spoken.push(text);
    for (const hook of onSpeak) await hook(text);
  };
  const consent = audioConsent({
    speak: speakLine,
    showCard: (c) => session!.setCard(c),
    nextUtterance: (ms) => {
      listening = true;
      return session!.waitAnswer(ms).finally(() => {
        listening = false;
      });
    },
    answerTimeoutMs: opts.answerTimeoutMs ?? 40,
  });
  const tk = await bootToolkit({ dataDir: dir, actingUser: 'margaret', consent });
  await tk.librarian.importProfileBlob(fixture as never);

  const speaker = createSpeaker({ speak: async (t) => speakLine(t) }, undefined, {
    sleep: async () => {},
    onRepeatPattern: (info) => session?.onRepeatPattern(info),
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
    setSystemInstruction() {},
    reset() {},
  });
  const frames = new FrameStore(3);
  session = createSession({
    frames,
    speaker,
    makeEngine,
    tk,
    panel: { emit: (e) => void events.push(e) },
    tasks: opts.tasks ?? [washingMachine as Task],
    vision: (opts.vision ?? null) as never,
    initialMode: 'baseline',
  });
  return { session, tk, spoken, events, turns, instructions, onSpeak, frames, isListening: () => listening };
}

const askedForProfile = (t: string) => /accessibility profile/.test(t);
const suggestedSlower = (t: string) => /speak a little slower/.test(t);
const taskStatus = (r: Awaited<ReturnType<typeof rig>>) =>
  r.events.find((e) => e.type === 'status' && e.text.startsWith('Task:'))?.text;

describe('bare consent answers (a card is up, nobody is listening yet)', () => {
  test('short all-yes / all-no utterances count', () => {
    for (const t of ['yes', 'Yes.', 'yes please', 'Okay!', "Yes, that's okay.", 'go ahead', 'Yeah, okay', 'Yes, go ahead']) {
      expect(parseBareConsentAnswer(t)).toBe('accept');
    }
    for (const t of ['no', 'Not now.', 'No thanks!', 'nope']) expect(parseBareConsentAnswer(t)).toBe('declineOnce');
  });
  test('requests, questions back, and hedges do not', () => {
    for (const t of ['Okay, start the washing machine', 'yes and which button now', 'sure thing', "I'm not sure", 'please help me', 'Okay?', 'Yes?']) {
      expect(parseBareConsentAnswer(t)).toBeNull();
    }
  });
});

describe('the grant question', () => {
  test('a "yes" while the question is still being spoken grants the profile', async () => {
    const r = await rig();
    r.onSpeak.push(async (t) => {
      if (askedForProfile(t)) await r.session.onUtterance('yes');
    });
    await r.session.setMode('toolkit');
    expect(r.session.state().granted).toBe(true);
    expect(r.session.state().consentCard).toBeNull();
    expect(r.session.state().rate).toBe(0.8);
  });

  test('consent answers work while paused (the question asked at boot)', async () => {
    const r = await rig();
    r.session.setPaused(true);
    r.onSpeak.push(async (t) => {
      if (askedForProfile(t)) await r.session.onUtterance('Yeah, okay');
    });
    await r.session.setMode('toolkit');
    expect(r.session.state().granted).toBe(true);
  });

  test('a "yes" during the listening window grants, and state shows it was listening', async () => {
    const r = await rig({ answerTimeoutMs: 3000 });
    const switching = r.session.setMode('toolkit');
    await waitFor(() => r.session.state().listening);
    await r.session.onUtterance('yes please');
    await switching;
    expect(r.session.state().granted).toBe(true);
    expect(r.session.state().listening).toBe(false);
  });

  test('a refusal that contains "okay" is not consent', async () => {
    const r = await rig({ answerTimeoutMs: 3000 });
    const switching = r.session.setMode('toolkit');
    await waitFor(r.isListening);
    await r.session.onUtterance("That's not okay");
    await waitFor(() => r.spoken.some((t) => /yes or a no/.test(t)));
    await waitFor(r.isListening);
    await r.session.onUtterance('no');
    await switching;
    expect(r.session.state().granted).toBe(false);
    expect(await r.tk.librarian.listGrants()).toHaveLength(0);
  });

  test('after silence the card is tap-only: a spoken "yes" does nothing, a tap grants', async () => {
    const r = await rig({ answerTimeoutMs: 20 });
    await r.session.setMode('toolkit');
    expect(r.session.state().consentCard?.kind).toBe('grant');
    await r.session.onUtterance('yes');
    expect(r.session.state().granted).toBe(false);
    await r.session.respondConsent('accept');
    expect(r.session.state().granted).toBe(true);
  });

  test('after silence, a later command starts the task — it is not taken as consent', async () => {
    const r = await rig({ answerTimeoutMs: 20 });
    await r.session.setMode('toolkit');
    await r.session.onUtterance('Okay, please help me start the washing machine');
    expect(r.session.state().granted).toBe(false);
    expect(r.turns).toContain('Okay, please help me start the washing machine');
  });

  test('switching mode clears an unanswered card', async () => {
    const r = await rig({ answerTimeoutMs: 20 });
    await r.session.setMode('toolkit');
    await r.session.setMode('baseline');
    expect(r.session.state().consentCard).toBeNull();
    await r.session.respondConsent('accept');
    expect(r.session.state().granted).toBe(false);
  });

  test('an accept that resolves after a switch to baseline is not applied', async () => {
    const r = await rig({ answerTimeoutMs: 20 });
    await r.session.setMode('toolkit'); // silence → tap-only card
    const hold = gate();
    let exportCalled = false;
    const realExport = r.tk.librarian.exportAbilityModel.bind(r.tk.librarian);
    r.tk.librarian.exportAbilityModel = async (appId: string) => {
      exportCalled = true;
      await hold.opened;
      return realExport(appId);
    };
    const tap = r.session.respondConsent('accept');
    await waitFor(() => exportCalled);
    await r.session.setMode('baseline');
    hold.open();
    await tap;
    expect(r.session.state().mode).toBe('baseline');
    expect(r.session.state().granted).toBe(false);
  });
});

describe('mode switches during the consent question', () => {
  test('a toggle while the question is spoken applies before setMode resolves, without waiting out the window', async () => {
    const r = await rig({ answerTimeoutMs: 5000 });
    let toggled: Promise<void> | null = null;
    r.onSpeak.push((t) => {
      if (askedForProfile(t)) toggled = r.session.setMode('baseline');
    });
    const started = Date.now();
    await r.session.setMode('toolkit');
    await toggled;
    expect(r.session.state().mode).toBe('baseline');
    expect(r.session.state().switching).toBe(false);
    expect(r.session.state().consentCard).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a toggle while capture is listening does not wait out the window', async () => {
    const r = await rig({ answerTimeoutMs: 5000 });
    const toToolkit = r.session.setMode('toolkit');
    await waitFor(r.isListening);
    const started = Date.now();
    await r.session.setMode('baseline');
    await toToolkit;
    expect(r.session.state().mode).toBe('baseline');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a toggle before the card is even shown does not open a listening window', async () => {
    const r = await rig({ answerTimeoutMs: 5000 });
    const realRequest = r.tk.librarian.requestGrant.bind(r.tk.librarian);
    let toggled: Promise<void> | null = null;
    r.tk.librarian.requestGrant = async (...args: Parameters<typeof realRequest>) => {
      toggled = r.session.setMode('baseline');
      return realRequest(...args);
    };
    const started = Date.now();
    await r.session.setMode('toolkit');
    await toggled;
    expect(r.session.state().mode).toBe('baseline');
    expect(r.session.state().consentCard).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the slow-down suggestion', () => {
  async function grantedTaskAtStep2(r: Awaited<ReturnType<typeof rig>>) {
    r.onSpeak.push(async (t) => {
      if (askedForProfile(t)) await r.session.onUtterance('yes');
    });
    await r.session.setMode('toolkit');
    await r.session.onUtterance('help me start the washing machine');
    await r.session.onUtterance('done');
  }

  test('a tap while it is spoken applies it once, and the next "done" still advances', async () => {
    const r = await rig({ replies: ['Open the drawer.', 'Put the soap in the big slot.', 'Turn the dial.'], answerTimeoutMs: 3000 });
    r.onSpeak.push(async (t) => {
      if (suggestedSlower(t)) await r.session.respondConsent('accept');
    });
    await grantedTaskAtStep2(r);
    await r.session.onUtterance('repeat');
    await r.session.onUtterance('repeat');
    await waitFor(() => r.session.state().rate === 0.7);

    await r.session.onUtterance('done');
    expect(r.turns.at(-1)).toBe("Done. What's the next step?");
    expect(r.spoken.some((t) => /yes or a no/.test(t))).toBe(false);
  });

  test('accepting changes only the rate — a floor need stays a floor', async () => {
    const r = await rig({ replies: ['Open the drawer.', 'Put the soap in the big slot.'], answerTimeoutMs: 3000 });
    const model = await r.tk.librarian.getAbilityModel();
    await r.tk.librarian.setProfileField(
      'fields.needs',
      model.needs.map((n) => (n.dimension === 'pacing' ? { ...n, strength: 'floor' } : n)),
    );
    r.onSpeak.push(async (t) => {
      if (suggestedSlower(t)) await r.session.respondConsent('accept');
    });
    await grantedTaskAtStep2(r);
    await r.session.onUtterance('repeat');
    await r.session.onUtterance('repeat');
    await waitFor(() => r.session.state().rate === 0.7);

    const after = await r.tk.librarian.getAbilityModel();
    const byDim = new Map(after.needs.map((n) => [n.dimension, n]));
    expect(after.needs).toHaveLength(4);
    expect(byDim.get('pacing')).toMatchObject({ value: 'stepwise', strength: 'floor', source: 'setup-script' });
    expect(byDim.get('simplify')?.source).toBe('onboarding-derived');
    expect(byDim.get('readAloudRate')).toMatchObject({ value: 0.7, source: 'wearable-extension-insight' });
  });

  test('left unanswered, the suggestion is withdrawn — a later "okay" advances the step instead of accepting it', async () => {
    const r = await rig({ replies: ['Open the drawer.', 'Put the soap in the big slot.', 'Turn the dial.'], answerTimeoutMs: 30 });
    await grantedTaskAtStep2(r);
    await r.session.onUtterance('repeat');
    await r.session.onUtterance('repeat');
    await waitFor(() => r.spoken.some(suggestedSlower));
    await waitFor(() => !r.session.state().listening && r.session.state().consentCard === null);

    await r.session.onUtterance('okay');
    expect(r.session.state().rate).toBe(0.8);
    expect(r.turns.at(-1)).toBe("Done. What's the next step?");
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
    const r = await rig({ replies: ['Open the door.', 'Slide the rack out.'], answerTimeoutMs: 3000 });
    r.onSpeak.push(async (t) => {
      if (askedForProfile(t)) await r.session.onUtterance('yes');
    });
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

  test('repeating two different answers once each is not "the same line twice"', async () => {
    const r = await rig({ replies: ['A kettle.', 'It boils water.'], answerTimeoutMs: 30 });
    r.onSpeak.push(async (t) => {
      if (askedForProfile(t)) await r.session.onUtterance('yes');
    });
    await r.session.setMode('toolkit');
    await r.session.onUtterance('what is in front of me');
    await r.session.onUtterance('repeat');
    await r.session.onUtterance('what does it do');
    await r.session.onUtterance('repeat');
    expect(r.spoken.filter(suggestedSlower)).toHaveLength(0);
    expect(r.session.state().rate).toBe(0.8);

    await r.session.onUtterance('repeat'); // now the same line twice
    await waitFor(() => r.spoken.some(suggestedSlower));
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
    const r = await rig({ replies: ['Open the door.'], vision: v, answerTimeoutMs: 3000 });
    await r.session.onUtterance('Help me start the dishwasher!');
    const baseline = r.instructions.at(-1)!;
    r.onSpeak.push(async (t) => {
      if (askedForProfile(t)) await r.session.onUtterance('yes');
    });
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
