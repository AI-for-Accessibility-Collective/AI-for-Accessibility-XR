// Voice adapter — carries out the speech settings (rate, pitch, steadiness,
// volume) on a voice engine. VENDOR GLUE: one function per engine, and the
// ONLY place an engine's parameter names appear. The least portable candidate
// in this folder — a different wearable brings its own engine and its own map.
//
//   toSpeakOptions  → ElevenLabs options (what Mentra's audio.speak takes;
//                     real numeric knobs — the filmed device voice)
//   styleLine       → Gemini TTS, which is prompt-steered: a natural-language
//                     style line prepended to the text (rehearsal voice)
//
// Same-voice A/B rule: under filmMode the voice_id is one constant for every
// utterance in both takes, and the voicePitch → low-pitch voice swap is
// DISABLED — the filmed contrast must come from delivery, never from a nicer
// voice. Outside film mode, pitchPreference 'low' selects the curated
// low-pitch voice (presbycusis: high-frequency loss makes lower voices easier).

import type { XRAudioSettings } from '../xr-audio.ts';

// Structurally identical to @mentra/sdk's SpeakOptions (= ElevenLabs options);
// declared here so this file needs no SDK.
export interface SpeakOptions {
  voice_id?: string;
  model_id?: string;
  voice_settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
    speed?: number;
  };
  volume?: number;
  stopOtherAudio?: boolean;
  trackId?: number;
}

// ElevenLabs "George" — the curated low-pitch pick for voicePitch: 'low'.
// Only consulted when film mode is off.
export const LOW_PITCH_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

export const SPEED_FLOOR = 0.7;
export const SPEED_CEIL = 1.2;

export interface MapOpts {
  // Per-utterance rate adjustment (the repeat slowdown: −0.1 on the second
  // repeat of the same step). Applied before the clamp.
  rateDelta?: number;
  // FILM_MODE: constant voice, no pitch swap. Defaults true — the safe state.
  filmMode?: boolean;
  // The one film voice. Empty string → omit voice_id (Mentra server default).
  voiceId?: string;
}

export function toSpeakOptions(r: XRAudioSettings, opts: MapOpts = {}): SpeakOptions {
  const { rateDelta = 0, filmMode = true, voiceId = '' } = opts;
  const speed = Math.min(SPEED_CEIL, Math.max(SPEED_FLOOR, r.speech.rate + rateDelta));

  const voice_settings: NonNullable<SpeakOptions['voice_settings']> = { speed };
  if (r.speech.expressiveness === 'steady') {
    voice_settings.stability = 0.75;
    voice_settings.style = 0;
  }

  const out: SpeakOptions = {
    voice_settings,
    volume: r.speech.volume,
  };
  if (r.speech.volume >= 1) out.voice_settings!.use_speaker_boost = true;

  if (filmMode) {
    if (voiceId) out.voice_id = voiceId;
  } else if (r.speech.pitchPreference === 'low') {
    out.voice_id = LOW_PITCH_VOICE_ID;
  } else if (voiceId) {
    out.voice_id = voiceId;
  }

  return out;
}

export function styleLine(r: XRAudioSettings, opts: { slower?: boolean } = {}): string {
  const parts: string[] = [];
  if (opts.slower) parts.push('even more slowly than before');
  else if (r.speech.rate <= 0.85) parts.push('slowly and clearly');
  else if (r.speech.rate < 1.0) parts.push('at an unhurried pace');
  if (r.speech.expressiveness === 'steady') parts.push('in a calm, even, warm tone');
  if (!parts.length) return '';
  return `Say the following ${parts.join(', ')}: `;
}

// Short names for a panel, one per thing styleLine asks the voice for — so a
// tag is only ever shown for something the voice was actually told. (Pitch is
// absent: styleLine does not carry it, and film mode turns the swap off.)
export function tags(r: XRAudioSettings, opts: { slower?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.slower) out.push('Slower repeat');
  else if (r.speech.rate < 1.0) out.push(`Slower speech · ${r.speech.rate}×`);
  if (r.speech.expressiveness === 'steady') out.push('Calm, even tone');
  return out;
}

// What the person is told the voice settings do.
export function effect(r: XRAudioSettings): string[] {
  const lines: string[] = [r.speech.rate === 1 ? 'Normal speed' : `Speaks at ${r.speech.rate}× speed`];
  if (r.speech.pitchPreference === 'low') lines.push('Lower-pitched voice');
  return lines;
}
