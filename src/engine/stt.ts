// Speech-to-text for the glasses microphone. The phone app forwards raw mic
// audio (16 kHz, 16-bit, mono PCM); this file cuts it into utterances and has
// Gemini write down each one.
//
// Why here and not on the phone: the Bluetooth SDK's on-phone transcription
// needs a speech model installed on the device, and nothing documents how to
// get one there. One Gemini call per utterance goes through the same spending
// guard as every other call (gemini-rest.ts).

import { generateContent } from './gemini-rest.ts';
import { pcmToWav } from './tts.ts';

export const MIC_SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (MIC_SAMPLE_RATE * 2) / 1000;

export interface SegmenterOpts {
  // RMS level (of 32768) above which a 20 ms window counts as speech. The
  // glasses' own loudness gate already turns quiet input into digital
  // silence, so this only has to clear line noise.
  threshold?: number;
  // Speech must run this long to open an utterance; a click doesn't.
  minSpeechMs?: number;
  // This much silence closes it.
  endSilenceMs?: number;
  // Audio kept from before the first loud window, so first syllables survive.
  preRollMs?: number;
  // An utterance is cut off here however long the person keeps talking.
  maxUtteranceMs?: number;
  // Silence this long is a first guess that the person has finished. If they
  // go on talking the guess is withdrawn; if they don't, the utterance closes
  // at endSilenceMs with the same audio plus the tail.
  tentativeSilenceMs?: number;
}

const WINDOW_MS = 20;
const WINDOW_BYTES = WINDOW_MS * BYTES_PER_MS;

function rms(window: Buffer): number {
  let sum = 0;
  const n = Math.floor(window.length / 2);
  for (let i = 0; i < n; i++) {
    const s = window.readInt16LE(i * 2);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

// Feed it PCM as it arrives; it calls onUtterance with each finished
// utterance's PCM. Pure and synchronous — no clock, no I/O.
export interface SegmenterEvents {
  // The person has stopped talking (endSilenceMs of quiet). `tentativeHeld`
  // is true when a tentative guess was made and never withdrawn — its audio
  // is this utterance without the trailing quiet, so any work begun on it
  // still applies.
  onUtterance(pcm: Buffer, tentativeHeld: boolean): void;
  onTentative?(pcm: Buffer): void;
  onTentativeWithdrawn?(): void;
  // The person has started talking. `agoMs` is how long before this call their
  // first sound was (the run of speech it takes to be sure, plus the pre-roll).
  onStart?(agoMs: number): void;
}

export function createSegmenter(handler: ((pcm: Buffer) => void) | SegmenterEvents, opts: SegmenterOpts = {}) {
  const events: SegmenterEvents = typeof handler === 'function' ? { onUtterance: handler } : handler;
  const onUtterance = events.onUtterance;
  const threshold = opts.threshold ?? 600;
  const minSpeechWindows = Math.ceil((opts.minSpeechMs ?? 120) / WINDOW_MS);
  const endSilenceWindows = Math.ceil((opts.endSilenceMs ?? 900) / WINDOW_MS);
  const preRollWindows = Math.ceil((opts.preRollMs ?? 300) / WINDOW_MS);
  const maxWindows = Math.ceil((opts.maxUtteranceMs ?? 15_000) / WINDOW_MS);
  const tentativeWindows = opts.tentativeSilenceMs != null ? Math.ceil(opts.tentativeSilenceMs / WINDOW_MS) : null;
  let tentative = false;

  let carry: Buffer = Buffer.alloc(0);
  let preRoll: Buffer[] = [];
  let current: Buffer[] | null = null;
  let loudRun = 0;
  let quietRun = 0;

  const close = (): void => {
    if (!current) return;
    // Drop the trailing silence that closed it, bar a short tail.
    const keep = Math.max(1, current.length - Math.max(0, quietRun - 5));
    const pcm = Buffer.concat(current.slice(0, keep));
    const held = tentative;
    current = null;
    loudRun = 0;
    quietRun = 0;
    tentative = false;
    preRoll = [];
    onUtterance(pcm, held);
  };

  return {
    push(chunk: Buffer): void {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      while (carry.length >= WINDOW_BYTES) {
        const window = carry.subarray(0, WINDOW_BYTES);
        carry = carry.subarray(WINDOW_BYTES);
        const loud = rms(window) >= threshold;
        if (current) {
          current.push(window);
          quietRun = loud ? 0 : quietRun + 1;
          if (loud && tentative) {
            tentative = false;
            events.onTentativeWithdrawn?.();
          }
          if (tentativeWindows != null && !tentative && quietRun === tentativeWindows && events.onTentative) {
            tentative = true;
            events.onTentative(Buffer.concat(current.slice(0, current.length - quietRun + 5)));
          }
          if (quietRun >= endSilenceWindows || current.length >= maxWindows) close();
          continue;
        }
        preRoll.push(window);
        if (preRoll.length > preRollWindows + minSpeechWindows) preRoll.shift();
        loudRun = loud ? loudRun + 1 : 0;
        if (loudRun >= minSpeechWindows) {
          current = preRoll;
          preRoll = [];
          quietRun = 0;
          events.onStart?.(minSpeechWindows * WINDOW_MS);
        }
      }
    },
    // Throw away anything half-heard (the guide started talking, or paused).
    reset(): void {
      carry = Buffer.alloc(0);
      preRoll = [];
      current = null;
      loudRun = 0;
      quietRun = 0;
      if (tentative) events.onTentativeWithdrawn?.();
      tentative = false;
    },
  };
}

const INSTRUCTION =
  'You transcribe one short voice command spoken to a smart-glasses assistant. ' +
  'Reply with exactly the words spoken, in plain text, nothing else. ' +
  'If there is no intelligible speech, reply with an empty line.';

// Returns the words, or '' when nothing intelligible was said or the call failed.
export async function transcribe(opts: { apiKey: string; model: string; pcm: Buffer }): Promise<string> {
  try {
    const out = await generateContent({
      apiKey: opts.apiKey,
      model: opts.model,
      systemInstruction: INSTRUCTION,
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'audio/wav', data: pcmToWav(opts.pcm, MIC_SAMPLE_RATE).toString('base64') } }],
        },
      ],
      maxOutputTokens: 120,
      temperature: 0,
      timeoutMs: 15_000,
    });
    const text = out.text.trim().replace(/^["'“]|["'”]$/g, '');
    // The model sometimes answers a cough or a clatter with "_" or "…".
    return /[\p{L}\p{N}]/u.test(text) ? text : '';
  } catch (e) {
    console.warn('[stt] transcription failed:', e instanceof Error ? e.message : e);
    return '';
  }
}
