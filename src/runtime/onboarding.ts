// createOnboarding — the spoken setup: a short conversation that fills in the
// profile by letting the person TRY two ways of doing the same thing and pick
// by ear, the way anyone sets up a new assistant.
//
//   welcome → pace → steps → words → detail → captions → wrap-up
//
// Each beat sets one need from toolkit/needs-catalog.ts. It never asks what a
// person finds hard and never names a reason for a choice; every answer is
// optional, and "skip", "go back", "say that again" and "stop" work anywhere.
// The wording below is the product — test/onboarding.test.ts scans every line
// of it for deficit vocabulary and for length, so the framing can't drift.
//
// Pure state machine: it speaks, understands, writes and reports only through
// `deps`, so the glasses entry (index.ts) and the tests drive the same code.
// A choice is written the moment it is made — stopping early, or losing the
// phone halfway, keeps what was chosen so far.

import { renderXRAudioSettings, type XRAudioSettings } from '../toolkit-candidates/xr-audio.ts';

export type NeedValue = boolean | string | number;

// What one reply came to. 'first'/'second' answer a beat that offers two ways;
// 'yes'/'no' answer a yes-or-no beat; the rest work on every beat.
export type Answer = 'first' | 'second' | 'yes' | 'no' | 'skip' | 'repeat' | 'back' | 'stop' | 'undecided';

export type BeatId = 'pace' | 'steps' | 'words' | 'detail' | 'captions';

// 'usual' and 'slower' pin a line to one delivery whatever has been chosen —
// the two takes of the pace sample. Unset: the pace chosen so far.
type Voice = 'usual' | 'slower';

export interface Line {
  text: string;
  voice?: Voice;
}

export interface BeatOption {
  value: NeedValue;
  // Said back at once, so a misheard answer is heard as one ("go back").
  ack: string;
  // Completes "I'll …" in the wrap-up.
  recap: string;
  // For a screen: the choice in a few words.
  label: string;
  // Words of this beat that point at this option ("slower", "one at a time").
  hint: RegExp;
  // What the option means, for the model that reads an unclear reply.
  means: string;
}

export interface Beat {
  id: BeatId;
  need: string;
  title: string;
  kind: 'pick' | 'yesno';
  // Said in order; the last one is the question.
  lines: Line[];
  // The question put another way, once, after two replies it could not read.
  rephrase: string;
  // [first, second] for a pick; [yes, no] for a yes-or-no.
  options: [BeatOption, BeatOption];
}

// The rate the second take is spoken at — and the value written when it wins.
export const SLOWER_RATE = 0.8;

const PACE_SAMPLE = 'Turn the dial to the right until you hear a soft click.';
const FIRST_WAY = "Here's the first way.";
const SECOND_WAY = "And here's the second way.";
const PICK_REPHRASE = 'You can say first, second, or again to hear both once more.';

export const WELCOME: Line[] = [
  { text: "Hi, I'm your Wearable Task Guide. Let's set me up so I sound the way you like." },
  { text: "It's three quick choices. Say skip to pass on any, and you can change everything later." },
];

export const BEATS: readonly Beat[] = [
  {
    id: 'pace',
    need: 'readAloudRate',
    title: 'Pace',
    kind: 'pick',
    lines: [
      { text: "First, my pace. You'll hear the same sentence two ways." },
      { text: FIRST_WAY, voice: 'usual' },
      { text: PACE_SAMPLE, voice: 'usual' },
      { text: SECOND_WAY, voice: 'usual' },
      { text: PACE_SAMPLE, voice: 'slower' },
      { text: 'Which pace suits you better, the first or the second?', voice: 'usual' },
    ],
    rephrase: PICK_REPHRASE,
    options: [
      {
        value: 1.0,
        ack: 'Got it, the first pace.',
        recap: 'talk at my usual pace',
        label: 'Pace: usual',
        hint: /(?<!too )\b(fast|faster|quick|quicker|normal|regular|usual|brisk|brisker|snappier)\b|\btoo slow\b/,
        means: 'the first take, at the usual speaking pace',
      },
      {
        value: SLOWER_RATE,
        ack: "Got it, the second pace. I'll keep to it from here.",
        recap: 'talk at an unhurried pace',
        label: 'Pace: unhurried',
        hint: /(?<!too )\b(slow|slower|slowly|calmer|relaxed|unhurried|gentler|steadier)\b|\btoo (fast|quick|rushed)\b/,
        means: 'the second take, at a slower, unhurried pace',
      },
    ],
  },
  {
    id: 'steps',
    need: 'pacing',
    title: 'Steps',
    kind: 'pick',
    lines: [
      { text: 'Next, how I walk you through things.' },
      { text: 'Would you like everything at once, or one step at a time, where I wait for you?' },
    ],
    rephrase: 'Some like the whole walkthrough in one go. Others like a step, then a pause. Which are you?',
    options: [
      {
        value: 'continuous',
        ack: 'Everything at once, got it.',
        recap: 'give you everything at once',
        label: 'Steps: all at once',
        hint: /\b(all at once|at once|everything|whole (thing|walkthrough|lot)|the whole|in one go|all in one|all together|straight through|all the steps|without (stopping|waiting|pausing))\b/,
        means: 'the whole walkthrough at once',
      },
      {
        value: 'stepwise',
        ack: "One step at a time. I'll wait for you.",
        recap: 'go one step at a time',
        label: 'Steps: one at a time',
        hint: /\b(one (step )?at a time|a step at a time|step by step|one by one|bit by bit|one step|each step|wait for me|waits?|pauses?)\b/,
        means: 'one step at a time, waiting for the person before the next',
      },
    ],
  },
  {
    id: 'captions',
    need: 'captions',
    title: 'Captions',
    kind: 'yesno',
    lines: [{ text: 'Last one. Would you like my words shown as text on your phone too?' }],
    rephrase: 'Should I also show what I say on your phone screen? Yes or no is fine.',
    options: [
      {
        value: true,
        ack: 'Text on your phone as well, done.',
        recap: 'show my words on your phone',
        label: 'Text on your phone: on',
        hint: /\b(show (it|them|me)|with (the )?(text|captions|words)|text (too|as well)|turn (it|them) on)\b/,
        means: 'yes, also show the words as text on the phone',
      },
      {
        value: false,
        ack: 'Voice only, got it.',
        recap: 'keep to voice only',
        label: 'Text on your phone: off',
        hint: /\b(just (the )?(voice|audio|sound)|(voice|audio|sound) only|only (the )?(voice|audio|sound)|without|no text|leave (it|them) off|turn (it|them) off)\b/,
        means: 'no, voice only',
      },
    ],
  },
];

// The guide takes the blame for a reply it could not read — never the person.
export const MISSED = 'Sorry, I missed that.';
export const GIVE_UP = "I'm not catching it, so let's leave that one as it is.";
export const SKIP_ACK = "Sure, we'll leave that one as it is.";
export const AT_START = "This is the first one, so there's nothing before it.";
export const NOT_SAVED = "That one didn't save, so it stays as it was.";
export const STOPPING = "Sure, we'll stop there.";
export const KEPT_SO_FAR = 'What you picked so far is saved.';
export const SAVED = "That's saved. You can change any of it anytime in My profile.";
export const NOTHING_CHOSEN = ["All set. I'll carry on just as I am.", 'You can set any of this anytime in My profile.'];
// Said by the host once the normal guide has taken over, in the new delivery.
export const READY_LINE = "I'm ready when you are. Just tell me what you're working on.";

const list = (parts: string[]): string =>
  parts.length <= 1 ? parts.join('') : parts.length === 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;

// Only what was actually chosen, in beat order. Three choices in one sentence
// is a lot to follow by ear, so two go in the first and the rest in a second.
export function recapLines(chosen: BeatOption[]): string[] {
  if (!chosen.length) return [...NOTHING_CHOSEN];
  const parts = chosen.map((o) => o.recap);
  const lines = [`All set. I'll ${list(parts.slice(0, 2))}.`];
  if (parts.length > 2) lines.push(`I'll also ${list(parts.slice(2))}.`);
  return [...lines, SAVED];
}

// Every sentence this flow can say — the script as data, for the wording
// guard and for anyone reviewing the copy.
export function allSpokenLines(): string[] {
  const out = new Set<string>([MISSED, GIVE_UP, SKIP_ACK, AT_START, NOT_SAVED, STOPPING, KEPT_SO_FAR, READY_LINE]);
  for (const l of WELCOME) out.add(l.text);
  for (const b of BEATS) {
    for (const l of b.lines) out.add(l.text);
    out.add(b.rephrase);
    for (const o of b.options) out.add(o.ack);
  }
  // Every wrap-up there can be: each beat left alone, or answered either way.
  const walk = (i: number, chosen: BeatOption[]): void => {
    if (i === BEATS.length) return void recapLines(chosen).forEach((l) => out.add(l));
    walk(i + 1, chosen);
    for (const o of BEATS[i]!.options) walk(i + 1, [...chosen, o]);
  };
  walk(0, []);
  return [...out];
}

// ── Understanding a reply ────────────────────────────────────────────────────

const STOP_RE =
  /^(please )?(stop|cancel|quit|exit|enough)( (it|this|that|now|here|there|please))*$|\b(that's|thats|that is) enough\b|\b(stop|end|cancel|quit|leave|exit|finish) (the |this |with the )?(setup|set up|onboarding|questions)\b|\bno more( questions)?\b|\b(i'm|im|i am) done\b/;
const BACK_RE = /\b(go|going|take me|step|move) back\b|^back$|\bprevious\b|\bone before\b|\bundo\b|\bchange (my|the) (last|previous) (answer|one|choice)\b/;
const REPEAT_RE =
  /\b(repeat|again|once more|one more time|come again|what was that|what did you say|didn't (catch|hear|get) (that|it|them)|play (it|that|them) back|replay)\b|^(sorry|pardon)( me)?$|^(what|huh)$/;
const SKIP_RE =
  /\b(skip|pass|move on|don't mind|do not mind|don't care|do not care|doesn't matter|does not matter|either|neither|whatever|whichever|no preference|not sure|unsure|don't know|do not know|dunno|can't (tell|decide)|couldn't tell|no difference|the same|you (choose|pick|decide)|up to you|never ?mind|not fussed|not bothered|(any|anything) (is fine|works|will do))\b|^next( one| question)?( please)?$|\bboth (are |were |is |sound |sounded |seem |seemed )?(fine|good|ok|okay|great|nice|alright)\b/;
const FIRST_RE = /\b(first|1st|former)\b|\b(number|option|way|choice|version|pace) (one|1|a)\b|^(the )?(one|1|a)( one)?( please)?$/;
const SECOND_RE = /\b(second|2nd|latter|last)\b|\b(number|option|way|choice|version|pace) (two|2|b|to|too)\b|^(the )?(two|2|b|bee)( one)?( please)?$/;
const YES_RE =
  /^(yes|yeah|yep|yup|sure|ok|okay|please|go on|go ahead|absolutely|definitely|of course|why not|sounds good|that would be (nice|good|great|handy)|that'd be (nice|good|great|handy)|i would|i'd (like|love) that)\b/;
const NO_RE = /^(no|nope|nah|not really|not for me|not now|i don't think so|don't|rather not|i'd rather not|negative)\b/;
const NEGATION_RE = /\b(not|never)\b|n't\b/;
const FILLER_RE = /^((oh|um|uh|er|hmm|well|so|okay so|right|let me think|i think|i guess|i suppose|maybe|probably)\s+)+/;

// Lower case, straight apostrophes, no punctuation — what the patterns expect.
function normalize(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The deterministic reading of a reply: instant, free, and right for the way
// people nearly always answer ("the second one", "slower", "skip it"). It
// says 'undecided' rather than guess — two signals that disagree, or a "not"
// next to an option, are for the model (interpretAnswer) or a second ask.
export function fastAnswer(beat: Beat, utterance: string): Answer {
  const said = normalize(utterance);
  if (!said) return 'undecided';
  if (STOP_RE.test(said)) return 'stop';
  if (BACK_RE.test(said)) return 'back';
  if (REPEAT_RE.test(said)) return 'repeat';

  // "No preference" must not read as "no", nor "either one" as "one".
  const skip = SKIP_RE.test(said);
  const rest = said.replace(new RegExp(SKIP_RE.source, 'g'), ' ').replace(/\s+/g, ' ').trim().replace(FILLER_RE, '');
  const [a, b] = beat.options;
  let first = a.hint.test(rest);
  let second = b.hint.test(rest);
  if (beat.kind === 'pick') {
    first ||= FIRST_RE.test(rest);
    second ||= SECOND_RE.test(rest);
  } else {
    first ||= YES_RE.test(rest);
    second ||= NO_RE.test(rest);
  }
  if (first && second) return 'undecided';
  if (!first && !second) return skip ? 'skip' : 'undecided';
  if (skip) return 'undecided';
  // "No" is itself a negation; anywhere else one turns the option around.
  const plainNo = beat.kind === 'yesno' && second;
  if (!plainNo && NEGATION_RE.test(rest)) return 'undecided';
  if (beat.kind === 'pick') return first ? 'first' : 'second';
  return first ? 'yes' : 'no';
}

const LABELS: Record<string, Answer> = {
  FIRST: 'first',
  SECOND: 'second',
  YES: 'yes',
  NO: 'no',
  SKIP: 'skip',
  REPEAT: 'repeat',
  BACK: 'back',
  STOP: 'stop',
  UNCLEAR: 'undecided',
};

// The labels a model may answer with for this beat — a closed set.
export function answerLabels(beat: Beat): string[] {
  return [...(beat.kind === 'pick' ? ['FIRST', 'SECOND'] : ['YES', 'NO']), 'SKIP', 'REPEAT', 'BACK', 'STOP', 'UNCLEAR'];
}

export function classifierPrompt(beat: Beat, utterance: string): string {
  const [a, b] = beat.options;
  const [la, lb] = answerLabels(beat);
  return [
    "Sort one spoken reply given during a voice assistant's setup.",
    `The assistant asked: "${beat.lines.at(-1)!.text}"`,
    `${la} means: ${a.means}. ${lb} means: ${b.means}.`,
    'SKIP means no preference, or wanting to move on. REPEAT means wanting to hear it again. BACK means wanting the previous question. STOP means wanting to end the setup. UNCLEAR means anything else.',
    `The reply: "${utterance.replace(/"/g, "'").slice(0, 300)}"`,
    `Answer with exactly one word from: ${answerLabels(beat).join(', ')}.`,
  ].join('\n');
}

export interface InterpretDeps {
  // One small model call: the prompt in, its text out. Absent → fast path only.
  classify?: (prompt: string) => Promise<string>;
}

// The fast path first; the model only for what it could not decide. Whatever
// the model says is held to the beat's closed set — anything else, or a
// failed call, is 'undecided', which the flow already knows how to handle.
export async function interpretAnswer(beat: Beat, utterance: string, deps: InterpretDeps = {}): Promise<Answer> {
  const fast = fastAnswer(beat, utterance);
  if (fast !== 'undecided' || !deps.classify || !normalize(utterance)) return fast;
  try {
    const label = (await deps.classify(classifierPrompt(beat, utterance))).trim().toUpperCase().replace(/[^A-Z]/g, '');
    return answerLabels(beat).includes(label) ? LABELS[label]! : 'undecided';
  } catch {
    return 'undecided';
  }
}

// ── The flow ─────────────────────────────────────────────────────────────────

export interface OnboardingChoice {
  beat: BeatId;
  need: string;
  value: NeedValue;
  label: string;
}

export interface OnboardingSummary {
  // 'completed': every beat was reached. 'stopped': the person ended it early.
  // 'aborted': the host ended it without a word (the guide was switched off).
  ended: 'completed' | 'stopped' | 'aborted';
  choices: OnboardingChoice[];
}

export interface OnboardingProgress {
  active: boolean;
  beat: number; // 0 while it says hello, then 1…beats
  beats: number;
  title: string;
  question: string;
}

export interface OnboardingDeps {
  // Speak one line; resolves when it has been heard. `render` is the delivery
  // to speak it with — always given, so the host never has to guess.
  say(text: string, opts?: { render?: XRAudioSettings }): Promise<void>;
  interpret(beat: Beat, utterance: string): Promise<Answer>;
  write(key: string, value: NeedValue): Promise<void>;
  onDone(summary: OnboardingSummary): void;
  // Lines that are coming up, so a host with a slow voice can make them early.
  prepare?(lines: Array<{ text: string; render: XRAudioSettings }>): void;
  // Progress moved (a new beat, the end) — a host pushes its panel state.
  onChange?(): void;
}

export interface Onboarding {
  start(): Promise<void>;
  onUtterance(text: string): Promise<void>;
  // End early, keeping what was chosen. Politely by default — the same as
  // saying "stop"; `silent` is for a host that is itself shutting up.
  cancel(opts?: { silent?: boolean }): Promise<void>;
  readonly active: boolean;
  readonly beat: Beat | null;
  progress(): OnboardingProgress;
  choices(): OnboardingChoice[];
}

const START = Symbol('start');
const STOP = Symbol('stop');
type Input = string | typeof START | typeof STOP;

const paceModel = (rate: number) => ({ needs: [{ dimension: 'readAloudRate', value: rate, strength: 'preference' as const }] });
const RENDERS: Record<Voice, XRAudioSettings> = {
  usual: renderXRAudioSettings(null),
  slower: renderXRAudioSettings(paceModel(SLOWER_RATE)),
};

export function createOnboarding(deps: OnboardingDeps): Onboarding {
  let active = false;
  // -1 while it says hello; BEATS.length once the choices are done.
  let index = -1;
  let misses = 0;
  const chosen = new Map<BeatId, BeatOption>();
  // A question has been put and no answer taken yet. Anything that arrives
  // outside that window (a tap during "Got it") has no question to belong to.
  let accepting = false;
  // One reply is worked on at a time. One more may wait — the newest — and
  // cuts the question being read short, which is what a "Skip this" tap wants.
  let running: Promise<void> | null = null;
  let waiting: Input | null = null;

  // Fixed lines carry the pace chosen so far: pick the second way and the
  // rest of the setup already talks that way. The other choices shape wording
  // and turn-taking, which a fixed script has none of.
  const paceVoice = (rate: NeedValue | undefined): XRAudioSettings => (rate === SLOWER_RATE ? RENDERS.slower : RENDERS.usual);
  const voice = (): XRAudioSettings => paceVoice(chosen.get('pace')?.value);
  const renderOf = (l: Line): XRAudioSettings => (l.voice ? RENDERS[l.voice] : voice());
  const plain = (texts: string[]): Line[] => texts.map((text) => ({ text }));

  // In beat order, whatever order they were made in ("go back").
  const chosenOptions = (): BeatOption[] => BEATS.filter((b) => chosen.has(b.id)).map((b) => chosen.get(b.id)!);
  const orderedChoices = (): OnboardingChoice[] =>
    BEATS.filter((b) => chosen.has(b.id)).map((b) => {
      const o = chosen.get(b.id)!;
      return { beat: b.id, need: b.need, value: o.value, label: o.label };
    });

  async function speak(lines: Line[], opts: { cuttable?: boolean } = {}): Promise<void> {
    for (const l of lines) {
      if (!active || waiting === STOP || (opts.cuttable && waiting != null)) return;
      await deps.say(l.text, { render: renderOf(l) });
    }
  }
  const prepare = (lines: Line[]): void => deps.prepare?.(lines.map((l) => ({ text: l.text, render: renderOf(l) })));

  async function enter(i: number): Promise<void> {
    if (!active) return;
    if (i >= BEATS.length) return wrapUp();
    const beat = BEATS[i]!;
    index = i;
    misses = 0;
    accepting = true;
    deps.onChange?.();
    prepare(beat.lines);
    // Each acknowledgement in the voice it would be said in — for the pace
    // beat, that is the pace it acknowledges.
    for (const o of beat.options) deps.prepare?.([{ text: o.ack, render: beat.id === 'pace' ? paceVoice(o.value) : voice() }]);
    await speak(beat.lines, { cuttable: true });
  }

  // The answer is in: nothing more is taken for this beat, and whatever was
  // waiting behind it was meant for this question, not the next.
  function settle(): void {
    accepting = false;
    if (waiting !== STOP) waiting = null;
  }
  const upcoming = (i: number): Line[] => (i < BEATS.length ? BEATS[i]!.lines : plain(recapLines(chosenOptions())));

  async function respond(text: string): Promise<void> {
    const beat = BEATS[index];
    if (!beat || !accepting) return;
    let answer: Answer;
    try {
      answer = await deps.interpret(beat, text);
    } catch {
      answer = 'undecided';
    }
    if (!active) return;
    const [one, two] = beat.kind === 'pick' ? (['first', 'second'] as const) : (['yes', 'no'] as const);
    const option = answer === one ? beat.options[0] : answer === two ? beat.options[1] : null;

    if (answer === 'stop') return finish('stopped');
    if (answer === 'back') {
      if (index === 0) return speak([{ text: AT_START }, beat.lines.at(-1)!], { cuttable: true });
      settle();
      return enter(index - 1);
    }
    if (answer === 'repeat') return speak(beat.lines, { cuttable: true });
    if (answer === 'skip') {
      settle();
      prepare(upcoming(index + 1));
      await speak([{ text: SKIP_ACK }]);
      return enter(index + 1);
    }
    if (option) {
      settle();
      try {
        await deps.write(beat.need, option.value);
        chosen.set(beat.id, option);
      } catch (e) {
        console.error(`[onboarding] could not save ${beat.need}:`, e instanceof Error ? e.message : e);
        await speak([{ text: NOT_SAVED }]);
        return enter(index + 1);
      }
      deps.onChange?.();
      prepare(upcoming(index + 1));
      await speak([{ text: option.ack }]);
      return enter(index + 1);
    }

    // Not understood (or an answer this beat has no use for, like "yes" to
    // "first or second?"). Ask again, then ask differently, then let it go —
    // nobody is kept in a loop.
    misses++;
    if (misses === 1) return speak([{ text: MISSED }, beat.lines.at(-1)!], { cuttable: true });
    if (misses === 2) return speak([{ text: beat.rephrase }], { cuttable: true });
    settle();
    prepare(upcoming(index + 1));
    await speak([{ text: GIVE_UP }]);
    return enter(index + 1);
  }

  async function wrapUp(): Promise<void> {
    index = BEATS.length;
    accepting = false;
    deps.onChange?.();
    await speak(plain(recapLines(chosenOptions())));
    end('completed');
  }

  async function finish(ended: 'stopped'): Promise<void> {
    accepting = false;
    waiting = null;
    await speak(plain(chosen.size ? [STOPPING, KEPT_SO_FAR] : [STOPPING]));
    end(ended);
  }

  function end(ended: OnboardingSummary['ended']): void {
    if (!active) return;
    active = false;
    accepting = false;
    waiting = null;
    deps.onChange?.();
    deps.onDone({ ended, choices: orderedChoices() });
  }

  // Never rejects: hosts fire these from mic and socket callbacks.
  function submit(input: Input): Promise<void> {
    if (!active) return Promise.resolve();
    if (running) {
      if (input === STOP) waiting = STOP;
      else if (accepting && waiting !== STOP) waiting = input;
      return running;
    }
    running = (async () => {
      let next: Input | null = input;
      while (next != null && active) {
        waiting = null;
        try {
          if (next === START) {
            prepare([...WELCOME, ...BEATS[0]!.lines]);
            await speak(WELCOME);
            if (waiting !== STOP) await enter(0);
          } else if (next === STOP) await finish('stopped');
          else await respond(next);
        } catch (e) {
          console.error('[onboarding] turn failed:', e instanceof Error ? e.message : e);
        }
        next = waiting;
      }
      waiting = null;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function start(): Promise<void> {
    if (active) return running ?? Promise.resolve();
    // A run that was just aborted may still be finishing its last line.
    if (running) return running.then(start);
    active = true;
    index = -1;
    misses = 0;
    accepting = false;
    chosen.clear();
    deps.onChange?.();
    return submit(START);
  }

  return {
    start,

    onUtterance(text: string): Promise<void> {
      const clean = text.trim();
      if (!clean) return Promise.resolve();
      return submit(clean);
    },

    cancel(opts: { silent?: boolean } = {}): Promise<void> {
      if (!active) return Promise.resolve();
      if (!opts.silent) return submit(STOP);
      end('aborted');
      return running ?? Promise.resolve();
    },

    get active(): boolean {
      return active;
    },

    get beat(): Beat | null {
      return active ? BEATS[index] ?? null : null;
    },

    progress(): OnboardingProgress {
      const beat = BEATS[index];
      return {
        active,
        beat: Math.max(0, Math.min(index + 1, BEATS.length)),
        beats: BEATS.length,
        title: !active ? '' : beat ? beat.title : index < 0 ? 'Welcome' : 'All set',
        question: active && beat && accepting ? beat.lines.at(-1)!.text : '',
      };
    },

    choices: orderedChoices,
  };
}
