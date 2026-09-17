// createSpeaker — the ONE place speech is shaped (docs/PLAN.md §3.4).
//
// Everything the app says goes through here, in both modes. What the render
// contributes is applied at this seam:
//   - chunking to delivery.maxWordsPerUtterance (sentence-packed, never
//     mid-sentence), with speech.pauseAfterUtteranceMs of silence between
//     chunks — the app-orchestration TTS layer (docs/DESIGN.md §5.1 layer 3);
//   - repeat memory: repeat() REPLAYS the last utterance's transcript
//     verbatim, never regenerates; the second repeat of the same step drops
//     the rate by 0.1 (the ElevenLabs map clamps at 0.7) and fires
//     onRepeatPattern — the insight beat's trigger. Lines said with
//     { remember: false } (an apology, a camera confirmation) are spoken but
//     never become what "repeat" replays;
//   - setRender() re-shapes live on the A/B toggle.
//
// Guardrail: in toolkit mode chunking/pacing apply even if the model rambles;
// in baseline the render defaults (maxWords null, 250 ms pause, 1.0×) mean
// the raw answer passes through as one unshaped utterance — that is the point.

import type { AudioRender } from './render.ts';
import { renderAudioSettings } from './render.ts';
import { toSpeakOptions, type MapOpts } from './elevenlabs-map.ts';
import type { SpeakOptions } from '../transport/mentra-io.ts';

export interface UtteranceMeta {
  // ElevenLabs/Mentra options for this chunk (rate delta already applied).
  speakOptions: SpeakOptions;
  // True on the slowed-down replay (second repeat of the same step).
  slower: boolean;
  // The render in effect — the demo sink derives its Gemini style line from it.
  render: AudioRender;
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
}

export interface SpeakerHooks {
  // Fired when the wearer has asked for the SAME step twice ("twice in one
  // minute" in the film): the signal the session turns into importInsight.
  onRepeatPattern?: (info: { stepId: string | null; count: number }) => void;
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
  setRender(r: AudioRender): void;
  render(): AudioRender;
  stop(): void;
  // Forget the repeat memory (transcript + per-step counts). Called on a mode
  // switch and on a new task, so a baseline take's repeats can never count
  // toward the toolkit take's insight beat.
  reset(): void;
  transcript(): string | null; // the last remembered utterance, verbatim
}

// Split into sentences, then pack sentences greedily into chunks of at most
// maxWords words. A single sentence longer than maxWords stays whole — the
// prompt block asks the model for short sentences; the speaker never breaks
// one mid-thought. null → one chunk (baseline).
export function chunkText(text: string, maxWords: number | null): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (maxWords == null) return [clean];
  const sentences = clean.split(/(?<=[.!?…])\s+/);
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const s of sentences) {
    const w = s.split(' ').length;
    if (current.length && words + w > maxWords) {
      chunks.push(current.join(' '));
      current = [];
      words = 0;
    }
    current.push(s);
    words += w;
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createSpeaker(sink: SpeakerSink, initial?: AudioRender, hooks: SpeakerHooks = {}): Speaker {
  let render = initial ?? renderAudioSettings(null);
  const sleep = hooks.sleep ?? defaultSleep;

  let last: { text: string; stepId: string | null } | null = null;
  const repeatCounts = new Map<string, number>();

  // stop() bumps the generation; in-flight loops check it between chunks.
  let generation = 0;
  // Serialize utterances so two say() calls never interleave chunks.
  let chain: Promise<unknown> = Promise.resolve();

  async function deliver(text: string, stepId: string | null, rateDelta: number, slower: boolean): Promise<void> {
    const gen = generation;
    const chunks = chunkText(text, render.delivery.maxWordsPerUtterance);
    for (let i = 0; i < chunks.length; i++) {
      if (gen !== generation) return;
      const speakOptions = toSpeakOptions(render, { rateDelta, ...hooks.mapOpts });
      await sink.speak(chunks[i]!, {
        speakOptions,
        slower,
        render,
        stepId,
        index: i,
        count: chunks.length,
      });
      if (gen !== generation) return;
      if (i < chunks.length - 1 && render.speech.pauseAfterUtteranceMs > 0) {
        await sleep(render.speech.pauseAfterUtteranceMs);
      }
    }
  }

  return {
    say(text: string, opts: SayOptions = {}): Promise<void> {
      const clean = text.trim();
      if (!clean) return Promise.resolve();
      const stepId = opts.stepId ?? null;
      if (opts.remember !== false) last = { text: clean, stepId };
      const run = () => deliver(clean, stepId, 0, false);
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },

    // Replay the transcript VERBATIM — never regenerate (a rephrased "repeat"
    // is exactly the failure the film shows baseline making). Second repeat of
    // the same step slows delivery and fires the repeat-pattern hook AFTER the
    // replay lands, so the insight question never talks over the step.
    repeat(): Promise<boolean> {
      if (!last) return Promise.resolve(false);
      const { text, stepId } = last;
      const key = stepId ?? '__last__';
      const count = (repeatCounts.get(key) ?? 0) + 1;
      repeatCounts.set(key, count);
      const slower = count >= 2;
      const run = () => deliver(text, stepId, slower ? -0.1 : 0, slower);
      const p = chain
        .then(run, run)
        .then(() => {
          if (slower) hooks.onRepeatPattern?.({ stepId, count });
          return true;
        });
      chain = p.catch(() => {});
      return p;
    },

    setRender(r: AudioRender): void {
      render = r;
    },

    render(): AudioRender {
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
