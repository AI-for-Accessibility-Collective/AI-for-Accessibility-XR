// Paced-delivery adapter — carries out the delivery settings on any voice:
// speech goes out in short chunks (delivery.maxWordsPerUtterance,
// sentence-packed, never mid-sentence) with a silence between them
// (speech.pauseAfterUtteranceMs). Engine-agnostic: the caller supplies the
// function that actually speaks one chunk.
//
// With default settings (maxWords null) the text passes through as ONE
// unshaped utterance — that is baseline.

import type { XRAudioSettings } from '../xr-audio.ts';

// Split into sentences, then pack sentences greedily into chunks of at most
// maxWords words. A single sentence longer than maxWords stays whole — the
// prompt directives ask the model for short sentences; this never breaks one
// mid-thought. null → one chunk.
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

export interface PacedOpts {
  // Injectable pause, so tests run on fake time.
  sleep?: (ms: number) => Promise<void>;
  // Checked between chunks and pauses; true stops the delivery (a "stop").
  cancelled?: () => boolean;
}

// Speak `text` chunk by chunk. `speakChunk` should resolve when the chunk is
// (approximately) done, so the pause runs after it, not during it.
export async function deliverPaced(
  text: string,
  settings: XRAudioSettings,
  speakChunk: (chunk: string, index: number, count: number) => Promise<void>,
  opts: PacedOpts = {},
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const cancelled = opts.cancelled ?? (() => false);
  const chunks = chunkText(text, settings.delivery.maxWordsPerUtterance);
  for (let i = 0; i < chunks.length; i++) {
    if (cancelled()) return;
    await speakChunk(chunks[i]!, i, chunks.length);
    if (cancelled()) return;
    if (i < chunks.length - 1 && settings.speech.pauseAfterUtteranceMs > 0) {
      await sleep(settings.speech.pauseAfterUtteranceMs);
    }
  }
}
