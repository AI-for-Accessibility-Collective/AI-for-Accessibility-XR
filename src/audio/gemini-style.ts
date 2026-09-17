// AudioRender → Gemini TTS style line (docs/DESIGN.md §5.1 layer 2).
//
// Gemini's TTS has no numeric knobs — it is prompt-steered — so the demo
// surface's laptop voice approximates the render with a natural-language
// style instruction prepended to the text. This is rehearsal-only fidelity;
// the filmed device voice is ElevenLabs via elevenlabs-map.ts.

import type { AudioRender } from './render.ts';

export function styleLine(r: AudioRender, opts: { slower?: boolean } = {}): string {
  const parts: string[] = [];
  if (opts.slower) parts.push('even more slowly than before');
  else if (r.speech.rate <= 0.85) parts.push('slowly and clearly');
  else if (r.speech.rate < 1.0) parts.push('at an unhurried pace');
  if (r.speech.expressiveness === 'steady') parts.push('in a calm, even, warm tone');
  if (!parts.length) return '';
  return `Say the following ${parts.join(', ')}: `;
}
