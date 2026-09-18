// createSpeaker — the ONE place speech is shaped (docs/PLAN.md §3.4).
//
// Everything the app says goes through here, in both modes. What the render
// contributes is applied at this seam:
//   - chunking and pauses — the paced-delivery adapter
//     (toolkit-candidates/adapters/paced-delivery.ts);
//   - the voice engine's options — the voice adapter (adapters/voice.ts);
//   - repeat memory: repeat() REPLAYS the last utterance's transcript
//     verbatim, never regenerates; the second repeat of the same step drops
//     the rate by 0.1 (the ElevenLabs map clamps at 0.7). Lines said with
//     { remember: false } (an apology, a camera confirmation) are spoken but
//     never become what "repeat" replays;
//   - setRender() re-shapes live on the A/B toggle.
//
// Guardrail: in toolkit mode chunking/pacing apply even if the model rambles;
// in baseline the render defaults (maxWords null, 250 ms pause, 1.0×) mean
// the raw answer passes through as one unshaped utterance — that is the point.

import { renderXRAudioSettings, type XRAudioSettings } from '../toolkit-candidates/xr-audio.ts';
import { chunkText, deliverPaced } from '../toolkit-candidates/adapters/paced-delivery.ts';
import { toSpeakOptions, type MapOpts, type SpeakOptions } from '../toolkit-candidates/adapters/voice.ts';

export interface UtteranceMeta {
  // ElevenLabs/Mentra options for this chunk (rate delta already applied).
  speakOptions: SpeakOptions;
  // True on the slowed-down replay (second repeat of the same step).
  slower: boolean;
  // The render in effect — the demo sink derives its Gemini style line from it.
  render: XRAudioSettings;
  // Which logical step this chunk belongs to, if the caller tagged one.
  stepId: string | null;
  // Chunk position, for sinks that show progress.
  index: number;
  count: number;
}

export interface SpeakerSink {
  // Deliver ONE chunk. Resolve when (approximately) done speaking so the
  // speaker's inter-chunk pause runs after delivery, not during it.
  speak(text: string, meta: UtteranceMeta): Promise<void>;
  // Called once with every chunk of an utterance before the first speak(), so a
  // sink that synthesizes speech can start on all of them at once instead of
  // one at a time between pauses.
  prepare?(chunks: string[], meta: Omit<UtteranceMeta, 'index' | 'count'>): void;
}

export interface SpeakerHooks {
  // Injectable pause, so tests run on fake time.
  sleep?: (ms: number) => Promise<void>;
  // FILM_MODE + voice for the ElevenLabs map.
  mapOpts?: Pick<MapOpts, 'filmMode' | 'voiceId'>;
}

export interface SayOptions {
  stepId?: string;
  // false: speak it, but keep the previous line as the repeat target.
  remember?: boolean;
}

export interface Speaker {
  say(text: string, opts?: SayOptions): Promise<void>;
  repeat(): Promise<boolean>; // false = nothing to repeat
  setRender(r: XRAudioSettings): void;
  render(): XRAudioSettings;
  stop(): void;
  // Forget the repeat memory (transcript + per-step counts). Called on a mode
  // switch and on a new task, so one take's repeats never slow the next.
  reset(): void;
  transcript(): string | null; // the last remembered utterance, verbatim
}

export function createSpeaker(sink: SpeakerSink, initial?: XRAudioSettings, hooks: SpeakerHooks = {}): Speaker {
  let render = initial ?? renderXRAudioSettings(null);

  let last: { text: string; stepId: string | null } | null = null;
  const repeatCounts = new Map<string, number>();

  // stop() bumps the generation; in-flight loops check it between chunks.
  let generation = 0;
  // Serialize utterances so two say() calls never interleave chunks.
  let chain: Promise<unknown> = Promise.resolve();

  // `gen` is the generation at ENQUEUE time: a stop() cancels everything
  // queued behind the line being spoken, not just that line — otherwise the
  // next step would start the moment the stopped one ended.
  function deliver(text: string, stepId: string | null, rateDelta: number, slower: boolean, gen: number): Promise<void> {
    if (gen !== generation) return Promise.resolve();
    const speakOptions = toSpeakOptions(render, { rateDelta, ...hooks.mapOpts });
    sink.prepare?.(chunkText(text, render.delivery.maxWordsPerUtterance), { speakOptions, slower, render, stepId });
    return deliverPaced(
      text,
      render,
      (chunk, index, count) => sink.speak(chunk, { speakOptions, slower, render, stepId, index, count }),
      { sleep: hooks.sleep, cancelled: () => gen !== generation },
    );
  }

  return {
    say(text: string, opts: SayOptions = {}): Promise<void> {
      const clean = text.trim();
      if (!clean) return Promise.resolve();
      const stepId = opts.stepId ?? null;
      if (opts.remember !== false) last = { text: clean, stepId };
      const gen = generation;
      const run = () => deliver(clean, stepId, 0, false, gen);
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },

    // Replay the transcript VERBATIM — never regenerate (a rephrased "repeat"
    // is exactly the failure the film shows baseline making). Second repeat of
    // the same step slows delivery a little.
    repeat(): Promise<boolean> {
      if (!last) return Promise.resolve(false);
      const { text, stepId } = last;
      const key = stepId ?? '__last__';
      const count = (repeatCounts.get(key) ?? 0) + 1;
      repeatCounts.set(key, count);
      const slower = count >= 2;
      const gen = generation;
      const run = () => deliver(text, stepId, slower ? -0.1 : 0, slower, gen);
      const p = chain.then(run, run).then(() => true);
      chain = p.catch(() => {});
      return p;
    },

    setRender(r: XRAudioSettings): void {
      render = r;
    },

    render(): XRAudioSettings {
      return render;
    },

    stop(): void {
      generation++;
    },

    reset(): void {
      generation++;
      last = null;
      repeatCounts.clear();
    },

    transcript(): string | null {
      return last?.text ?? null;
    },
  };
}
