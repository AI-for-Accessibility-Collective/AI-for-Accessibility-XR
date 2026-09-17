// AudioRender → Mentra/ElevenLabs SpeakOptions (docs/DESIGN.md §7.1 mapper
// table). One pure function; the ONLY place ElevenLabs parameter names appear.
//
// Same-voice A/B rule (§2): under FILM_MODE the voice_id is one constant for
// every utterance in both takes, and the voicePitch → low-pitch voice swap is
// DISABLED — the filmed contrast must come from delivery, never from a nicer
// voice. Outside film mode, pitchPreference 'low' selects the curated
// low-pitch voice (presbycusis: high-frequency loss makes lower voices easier).

import type { SpeakOptions } from '../transport/mentra-io.ts';
import type { AudioRender } from './render.ts';

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

export function toSpeakOptions(r: AudioRender, opts: MapOpts = {}): SpeakOptions {
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
