// onboarding.test.ts — the spoken setup, end to end with fakes: what it says,
// what it writes, how it reads a reply, and how it lets go. No network and no
// Gemini: the model that reads unclear replies is a function the test passes.
// The last block guards the WORDING — the flow is "try it and pick", and a
// line that starts asking about difficulties must fail here, not on film.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allSpokenLines,
  answerLabels,
  AT_START,
  BEATS,
  createOnboarding,
  fastAnswer,
  GIVE_UP,
  interpretAnswer,
  KEPT_SO_FAR,
  MISSED,
  NOT_SAVED,
  recapLines,
  SAVED,
  SKIP_ACK,
  SLOWER_RATE,
  STOPPING,
  WELCOME,
  type Answer,
  type Beat,
  type NeedValue,
  type OnboardingSummary,
} from '../src/runtime/onboarding.ts';
import { bootToolkit, ONBOARDING_SOURCE, readModel, writeNeed } from '../src/toolkit/host.ts';
import { checkNeedValue } from '../src/toolkit/needs-catalog.ts';
import { styleLine } from '../src/toolkit-candidates/adapters/voice.ts';
import type { XRAudioSettings } from '../src/toolkit-candidates/xr-audio.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const beat = (id: string): Beat => BEATS.find((b) => b.id === id)!;
const question = (id: string): string => beat(id).lines.at(-1)!.text;
const PACE_SAMPLE = beat('pace').lines[2]!.text;

interface RigOpts {
  interpret?: (beat: Beat, utterance: string) => Promise<Answer>;
  write?: (key: string, value: NeedValue) => Promise<void>;
  // say() waits for this before resolving — a line that is still playing.
  hold?: () => Promise<void> | void;
}

function rig(opts: RigOpts = {}) {
  const said: Array<{ text: string; render: XRAudioSettings }> = [];
  const writes: Array<[string, NeedValue]> = [];
  const done: OnboardingSummary[] = [];
  const onboarding = createOnboarding({
    say: async (text, o) => {
      said.push({ text, render: o!.render! });
      await opts.hold?.();
    },
    interpret: opts.interpret ?? ((b, u) => interpretAnswer(b, u)),
    write:
      opts.write ??
      (async (key, value) => {
        writes.push([key, value]);
      }),
    onDone: (s) => done.push(s),
  });
  const texts = () => said.map((s) => s.text);
  // What was said since the last call — one turn's worth.
  let mark = 0;
  const fresh = () => {
    const out = texts().slice(mark);
    mark = said.length;
    return out;
  };
  return { onboarding, said, texts, fresh, writes, done };
}

describe('the flow', () => {
  test('happy path: three choices by ear, each written as it is made, then a recap of exactly those', async () => {
    const r = rig();
    await r.onboarding.start();
    expect(r.fresh()).toEqual([...WELCOME.map((l) => l.text), ...beat('pace').lines.map((l) => l.text)]);
    expect(r.onboarding.progress()).toMatchObject({ active: true, beat: 1, beats: 3, title: 'Pace', question: question('pace') });

    await r.onboarding.onUtterance('the second one');
    expect(r.writes).toEqual([['readAloudRate', SLOWER_RATE]]);
    expect(r.fresh()).toEqual([beat('pace').options[1].ack, ...beat('steps').lines.map((l) => l.text)]);

    await r.onboarding.onUtterance('one at a time please');
    expect(r.onboarding.progress()).toMatchObject({ beat: 3, title: 'Captions' });
    await r.onboarding.onUtterance('yes please');

    expect(r.writes).toEqual([
      ['readAloudRate', SLOWER_RATE],
      ['pacing', 'stepwise'],
      ['captions', true],
    ]);
    expect(r.texts().slice(-3)).toEqual([
      "All set. I'll talk at an unhurried pace and go one step at a time.",
      "I'll also show my words on your phone.",
      SAVED,
    ]);
    expect(r.done).toHaveLength(1);
    expect(r.done[0]!.ended).toBe('completed');
    expect(r.done[0]!.choices.map((c) => c.need)).toEqual(['readAloudRate', 'pacing', 'captions']);
    expect(r.onboarding.active).toBe(false);
    expect(r.onboarding.beat).toBeNull();
  });

  test('the other way round writes the defaults explicitly — a choice, not an absence', async () => {
    const r = rig();
    await r.onboarding.start();
    for (const reply of ['the first', 'all at once', 'nope']) await r.onboarding.onUtterance(reply);
    expect(r.writes).toEqual([
      ['readAloudRate', 1.0],
      ['pacing', 'continuous'],
      ['captions', false],
    ]);
  });

  test('every value it can write is one the catalog accepts', () => {
    for (const b of BEATS) for (const o of b.options) expect(checkNeedValue(b.need, o.value)).toEqual({ ok: true, value: o.value });
  });

  test('on a real store: written as a preference, from the spoken setup, leaving other needs alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wearable-ext-onboarding-'));
    dirs.push(dir);
    const tk = await bootToolkit({ dataDir: dir, actingUser: 'margaret' });
    await writeNeed(tk, 'voicePitch', 'low'); // already there, from the editor
    const r = rig({ write: async (key, value) => void (await writeNeed(tk, key, value, ONBOARDING_SOURCE)) });
    await r.onboarding.start();
    for (const reply of ['slower was nicer', "I don't mind", 'yes']) await r.onboarding.onUtterance(reply);
    const needs = (await readModel(tk))!.needs!;
    const bySource = (source: string) => needs.filter((n) => n.source === source).map((n) => [n.dimension, n.value, n.strength]);
    expect(bySource(ONBOARDING_SOURCE)).toEqual([
      ['readAloudRate', 0.8, 'preference'],
      ['captions', true, 'preference'],
    ]);
    expect(bySource('profile-editor')).toEqual([['voicePitch', 'low', 'preference']]);
    expect(needs).toHaveLength(3);
  });

  test('"don\'t mind", "either", "skip": nothing is written for that beat and the recap leaves it out', async () => {
    const r = rig();
    await r.onboarding.start();
    await r.onboarding.onUtterance("I don't mind");
    expect(r.writes).toEqual([]);
    expect(r.fresh().slice(-3)).toEqual([SKIP_ACK, ...beat('steps').lines.map((l) => l.text)]);
    await r.onboarding.onUtterance('either is fine');
    await r.onboarding.onUtterance('yes please');
    expect(r.writes).toEqual([['captions', true]]);
    expect(r.texts().slice(-2)).toEqual(["All set. I'll show my words on your phone.", SAVED]);
  });

  test('nothing chosen at all: says so plainly and claims nothing was saved', async () => {
    const r = rig();
    await r.onboarding.start();
    for (let i = 0; i < 5; i++) await r.onboarding.onUtterance('skip');
    expect(r.writes).toEqual([]);
    expect(r.texts().slice(-2)).toEqual(recapLines([]));
    expect(r.texts()).not.toContain(SAVED);
    expect(r.done[0]).toEqual({ ended: 'completed', choices: [] });
  });

  test('"say that again" replays the whole beat, samples included, and changes nothing', async () => {
    const r = rig();
    await r.onboarding.start();
    r.fresh();
    await r.onboarding.onUtterance('say that again');
    expect(r.fresh()).toEqual(beat('pace').lines.map((l) => l.text));
    expect(r.writes).toEqual([]);
    expect(r.onboarding.progress().beat).toBe(1);
  });

  test('"go back" returns to the previous beat, and a new answer there replaces the old one', async () => {
    const r = rig();
    await r.onboarding.start();
    await r.onboarding.onUtterance('the second');
    r.fresh();
    await r.onboarding.onUtterance('go back');
    expect(r.fresh()).toEqual(beat('pace').lines.map((l) => l.text));
    expect(r.onboarding.progress().title).toBe('Pace');
    await r.onboarding.onUtterance('the first');
    expect(r.writes).toEqual([
      ['readAloudRate', SLOWER_RATE],
      ['readAloudRate', 1.0],
    ]);
    for (let i = 0; i < 4; i++) await r.onboarding.onUtterance('skip');
    expect(r.done[0]!.choices).toEqual([{ beat: 'pace', need: 'readAloudRate', value: 1.0, label: 'Pace: usual' }]);
  });

  test('"go back" on the first beat says there is nothing before it and asks again', async () => {
    const r = rig();
    await r.onboarding.start();
    r.fresh();
    await r.onboarding.onUtterance('go back');
    expect(r.fresh()).toEqual([AT_START, question('pace')]);
    expect(r.onboarding.progress().beat).toBe(1);
  });

  test('not understood: asks again, then asks differently once, then lets it go — never a loop', async () => {
    const r = rig();
    await r.onboarding.start();
    r.fresh();
    await r.onboarding.onUtterance('purple monkey dishwasher');
    expect(r.fresh()).toEqual([MISSED, question('pace')]);
    await r.onboarding.onUtterance('the weather is lovely');
    expect(r.fresh()).toEqual([beat('pace').rephrase]);
    await r.onboarding.onUtterance('bananas');
    expect(r.fresh()).toEqual([GIVE_UP, ...beat('steps').lines.map((l) => l.text)]);
    expect(r.writes).toEqual([]);
    // The count is per beat: the next one gets its own patience.
    await r.onboarding.onUtterance('bananas');
    expect(r.fresh()).toEqual([MISSED, question('steps')]);
  });

  test('an answer the beat has no use for ("yes" to first-or-second) counts as not understood', async () => {
    const r = rig();
    await r.onboarding.start();
    r.fresh();
    await r.onboarding.onUtterance('yes');
    expect(r.fresh()).toEqual([MISSED, question('pace')]);
    expect(r.writes).toEqual([]);
  });

  test('"that\'s enough" ends early and keeps what was chosen so far', async () => {
    const r = rig();
    await r.onboarding.start();
    await r.onboarding.onUtterance('the second one');
    r.fresh();
    await r.onboarding.onUtterance("that's enough");
    expect(r.fresh()).toEqual([STOPPING, KEPT_SO_FAR]);
    expect(r.done).toEqual([{ ended: 'stopped', choices: [{ beat: 'pace', need: 'readAloudRate', value: SLOWER_RATE, label: 'Pace: unhurried' }] }]);
    expect(r.onboarding.active).toBe(false);
    // Over means over: a late reply is nobody's answer.
    await r.onboarding.onUtterance('the first');
    expect(r.writes).toHaveLength(1);
  });

  test('cancel() is the same as saying stop; with nothing chosen it promises nothing', async () => {
    const r = rig();
    await r.onboarding.start();
    r.fresh();
    await r.onboarding.cancel();
    expect(r.fresh()).toEqual([STOPPING]);
    expect(r.done).toEqual([{ ended: 'stopped', choices: [] }]);
  });

  test('cancel({silent}) says nothing — the host is going quiet — and still reports what was kept', async () => {
    const r = rig();
    await r.onboarding.start();
    await r.onboarding.onUtterance('slower');
    r.fresh();
    await r.onboarding.cancel({ silent: true });
    expect(r.fresh()).toEqual([]);
    expect(r.done[0]!.ended).toBe('aborted');
    expect(r.done[0]!.choices).toHaveLength(1);
    expect(r.onboarding.active).toBe(false);
  });

  test('a choice that fails to save is said so, left out of the recap, and does not stop the flow', async () => {
    const r = rig({
      write: async (key) => {
        if (key === 'readAloudRate') throw new Error('disk full');
      },
    });
    const errors = console.error;
    console.error = () => {};
    try {
      await r.onboarding.start();
      r.fresh();
      await r.onboarding.onUtterance('the second');
      expect(r.fresh()[0]).toBe(NOT_SAVED);
      expect(r.onboarding.progress().title).toBe('Steps');
      expect(r.onboarding.choices()).toEqual([]);
    } finally {
      console.error = errors;
    }
  });

  test('a tap while the question is still being read cuts it short and is taken as the answer', async () => {
    let release: (() => void) | null = null;
    const r = rig({ hold: () => new Promise<void>((resolve) => (release = resolve)) });
    const step = async () => {
      await Bun.sleep(1);
      release?.();
      await Bun.sleep(1);
    };
    const started = r.onboarding.start();
    await step(); // welcome 1
    await step(); // welcome 2
    await step(); // pace: intro — now mid-beat, "Here's the first way." is playing
    expect(r.texts().at(-1)).toBe(beat('pace').lines[1]!.text);
    const tapped = r.onboarding.onUtterance('skip');
    for (let i = 0; i < 8; i++) await step();
    await Promise.all([started, tapped]);
    // The samples were never played; it went straight on to the next beat.
    expect(r.texts()).not.toContain(PACE_SAMPLE);
    expect(r.texts()).toContain(SKIP_ACK);
    expect(r.onboarding.progress().title).toBe('Steps');
  });

  test('start() while it is running changes nothing; after it has ended it starts clean', async () => {
    const r = rig();
    await r.onboarding.start();
    await r.onboarding.onUtterance('the second');
    const before = r.texts().length;
    await r.onboarding.start();
    expect(r.texts().length).toBe(before);
    await r.onboarding.cancel({ silent: true });
    await r.onboarding.start();
    expect(r.onboarding.progress()).toMatchObject({ active: true, beat: 1 });
    expect(r.onboarding.choices()).toEqual([]);
  });
});

describe('the pace beat', () => {
  test('speaks the SAME sentence twice, with two different renders — default, then 0.8×', async () => {
    const r = rig();
    await r.onboarding.start();
    const samples = r.said.filter((s) => s.text === PACE_SAMPLE);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.render.speech.rate)).toEqual([1.0, SLOWER_RATE]);
    // What actually reaches the voice: no style line, then a slow one.
    expect(styleLine(samples[0]!.render)).toBe('');
    expect(styleLine(samples[1]!.render)).toContain('slowly');
    // The question itself is asked in the usual voice, not in either take's favour.
    expect(r.said.at(-1)!.render.speech.rate).toBe(1.0);
  });

  test('choosing the second way is heard at once: the rest of the setup talks that way', async () => {
    const r = rig();
    await r.onboarding.start();
    const before = r.said.length;
    await r.onboarding.onUtterance('the second one');
    expect(r.said.slice(before).every((s) => s.render.speech.rate === SLOWER_RATE)).toBe(true);
  });

  test('choosing the first way keeps the usual voice', async () => {
    const r = rig();
    await r.onboarding.start();
    const before = r.said.length;
    await r.onboarding.onUtterance('the first');
    expect(r.said.slice(before).every((s) => s.render.speech.rate === 1.0)).toBe(true);
  });
});

describe('fastAnswer — the deterministic reading', () => {
  const table: Array<[string, string, Answer]> = [
    // picking by ear
    ['pace', 'the second one', 'second'],
    ['pace', 'number two', 'second'],
    ['pace', 'B', 'second'],
    ['pace', 'slower', 'second'],
    ['pace', 'Slower was nicer.', 'second'],
    ['pace', 'the last one', 'second'],
    ['pace', 'option b please', 'second'],
    ['pace', 'the first', 'first'],
    ['pace', 'The first one, please.', 'first'],
    ['pace', 'number one', 'first'],
    ['pace', 'A', 'first'],
    ['pace', 'um, the faster one', 'first'],
    ['steps', 'one at a time please', 'second'],
    ['steps', 'step by step', 'second'],
    ['steps', 'all at once', 'first'],
    ['steps', 'just give me the whole thing', 'first'],
    ['steps', 'stop after each step and wait for me', 'second'],
    // yes / no
    ['captions', 'yes please', 'yes'],
    ['captions', 'Yeah, sure.', 'yes'],
    ['captions', 'okay', 'yes'],
    ['captions', 'nope', 'no'],
    ['captions', 'No thanks.', 'no'],
    ['captions', 'not really', 'no'],
    ['captions', 'just the voice', 'no'],
    // no preference
    ['pace', 'neither', 'skip'],
    ['pace', 'either is fine', 'skip'],
    ['pace', "I don't mind", 'skip'],
    ['pace', 'skip it', 'skip'],
    ['pace', 'whatever', 'skip'],
    ['pace', 'they sounded the same to me', 'skip'],
    ['captions', 'no preference', 'skip'],
    ['steps', 'up to you', 'skip'],
    // the controls
    ['pace', 'say that again', 'repeat'],
    ['pace', 'Could I hear them again?', 'repeat'],
    ['steps', 'go back', 'back'],
    ['steps', 'Back.', 'back'],
    ['pace', 'stop', 'stop'],
    ['pace', 'cancel', 'stop'],
    ['captions', "that's enough", 'stop'],
    // better undecided than wrong
    ['pace', 'the first one was too fast', 'undecided'],
    ['pace', 'not the second one', 'undecided'],
    ['pace', 'not sure, maybe the second', 'undecided'],
    ['pace', 'yes', 'undecided'],
    ['captions', 'the first', 'undecided'],
    ['steps', 'hmm', 'undecided'],
    ['pace', '', 'undecided'],
  ];
  for (const [id, said, want] of table) {
    test(`${id}: "${said}" → ${want}`, () => {
      expect(fastAnswer(beat(id), said)).toBe(want);
    });
  }
});

describe('interpretAnswer — the model only for what the fast path could not decide', () => {
  const counting = (reply: string | Error) => {
    const prompts: string[] = [];
    const classify = async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return { prompts, classify };
  };

  test('a reply the fast path reads never reaches the model', async () => {
    const m = counting('FIRST');
    expect(await interpretAnswer(beat('pace'), 'the second one', m)).toBe('second');
    expect(await interpretAnswer(beat('pace'), 'skip', m)).toBe('skip');
    expect(await interpretAnswer(beat('captions'), 'nope', m)).toBe('no');
    expect(m.prompts).toEqual([]);
  });

  test('an undecided reply goes to the model once, with the question, both options and the closed set', async () => {
    const m = counting('SECOND');
    expect(await interpretAnswer(beat('pace'), 'the first one was too fast', m)).toBe('second');
    expect(m.prompts).toHaveLength(1);
    expect(m.prompts[0]).toContain(question('pace'));
    expect(m.prompts[0]).toContain('the first one was too fast');
    expect(m.prompts[0]).toContain(answerLabels(beat('pace')).join(', '));
  });

  test('the model may be sloppy about case and punctuation, not about the label', async () => {
    expect(await interpretAnswer(beat('pace'), 'the mellow take', counting(' second.\n'))).toBe('second');
    expect(await interpretAnswer(beat('captions'), 'that would help me follow along', counting('Yes'))).toBe('yes');
    expect(await interpretAnswer(beat('pace'), 'the mellow take', counting('UNCLEAR'))).toBe('undecided');
  });

  test('garbage, a sentence, an empty answer, or a label from another beat → undecided', async () => {
    for (const out of ['', 'banana', 'I think they meant SECOND', 'FIRST SECOND', '{"answer":"second"}', 'YES']) {
      expect(await interpretAnswer(beat('pace'), 'the mellow take', counting(out))).toBe('undecided');
    }
    expect(await interpretAnswer(beat('captions'), 'if it is not too distracting', counting('FIRST'))).toBe('undecided');
  });

  test('a failed model call is undecided, not an exception', async () => {
    expect(await interpretAnswer(beat('pace'), 'the mellow take', counting(new Error('HTTP 429')))).toBe('undecided');
  });

  test('silence never costs a model call', async () => {
    const m = counting('SKIP');
    expect(await interpretAnswer(beat('pace'), '  …  ', m)).toBe('undecided');
    expect(m.prompts).toEqual([]);
  });

  test('in the flow: a model-read reply is written like any other', async () => {
    const m = counting('SECOND');
    const r = rig({ interpret: (b, u) => interpretAnswer(b, u, m) });
    await r.onboarding.start();
    await r.onboarding.onUtterance('the first one was too fast');
    expect(r.writes).toEqual([['readAloudRate', SLOWER_RATE]]);
    expect(m.prompts).toHaveLength(1);
  });
});

describe('the wording guard', () => {
  // The flow is "try it and pick". None of these belong in it, in any form.
  const DEFICIT = [
    /disab/i,
    /impair/i,
    /difficult/i,
    /trouble/i,
    /struggl/i,
    /problem/i,
    /condition/i,
    /accessib/i,
    /need(s|ed)? help/i,
    /\bcan'?t\b/i,
    /\bcannot\b/i,
    /unable/i,
    /hard for you/i,
    /\bsuffer/i,
    /\bdisorder/i,
    /\bspecial needs?\b/i,
  ];
  const lines = allSpokenLines();

  test('the script is all there: welcome, three beats, every acknowledgement and every possible recap', () => {
    expect(BEATS.map((b) => b.need)).toEqual(['readAloudRate', 'pacing', 'captions']);
    for (const l of WELCOME) expect(lines).toContain(l.text);
    for (const b of BEATS) for (const o of b.options) expect(lines).toContain(o.ack);
    expect(lines.length).toBeGreaterThan(30);
  });

  test('no line uses deficit vocabulary', () => {
    for (const line of lines) for (const re of DEFICIT) expect({ line, banned: re.test(line) }).toEqual({ line, banned: false });
  });

  test('no line is longer than 20 words', () => {
    for (const line of lines) expect({ line, words: line.split(/\s+/).length <= 20 }).toEqual({ line, words: true });
  });

  test('every line is a plain sentence a voice can say: no markup, no symbols, ends like a sentence', () => {
    for (const line of lines) {
      expect({ line, ok: /^[A-Za-z][A-Za-z0-9 ,.'?]*[.?]$/.test(line) }).toEqual({ line, ok: true });
    }
  });

  test('it never asks why: no question about the person, only about how the guide should behave', () => {
    const questions = lines.filter((l) => l.includes('?'));
    expect(questions.length).toBeGreaterThanOrEqual(BEATS.length);
    for (const q of questions) expect({ q, ok: !/\b(why|do you have|are you able|how (well|badly)|what do you find)\b/i.test(q) }).toEqual({ q, ok: true });
  });
});
