// The wire between the phone app (phone/, built on the Mentra Bluetooth SDK)
// and this server: one WebSocket at /phone. JSON text frames carry the
// messages below; binary frames going up are glasses-microphone audio
// (16 kHz, 16-bit, mono, little-endian PCM), sent only while the guide is on.
//
// Types only. Both sides import this file, so it must stay free of runtime
// code and of Node, Bun, DOM and React Native APIs.
//
// The phone is a thin relay. It owns nothing but the Bluetooth link: the
// wearer's voice goes up, the guide's voice comes down as audio to play, and
// the glasses publish their camera straight to this server's RTMP port.

export const PHONE_WS_PATH = '/phone';

export type GuideModeWire = 'baseline' | 'toolkit';

// What the phone screen shows. Pushed on every change.
// What the guide is doing right now, so the wearer is never left guessing.
export type GuidePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface PanelState {
  active: boolean;
  mode: GuideModeWire;
  phase: GuidePhase;
  // The last thing the guide understood the wearer to say.
  heard: string;
  lastLine: string;
  // One line on what the glasses side is doing ("Camera streaming", "Glasses need Wi-Fi").
  status: string;
  // Why Gemini is off for the rest of this server run, or null.
  geminiOff: string | null;
}

// ── phone → server ───────────────────────────────────────────────────────────
export type UpMessage =
  | { t: 'hello'; token: string; app: string }
  | { t: 'glasses'; connected: boolean; wifi: boolean | null }
  | { t: 'control'; action: 'active'; value: boolean }
  | { t: 'control'; action: 'mode'; value: GuideModeWire }
  | { t: 'control'; action: 'say'; value: string }
  | { t: 'reply'; id: number; ok: boolean; detail?: string } // answers a DownRequest
  | { t: 'ping' };

// ── server → phone ───────────────────────────────────────────────────────────
// Requests carry an id and are answered with a 'reply' once the phone is done:
// the audio finished playing, or the glasses reported the stream as started.
export type DownRequest =
  // audioPath null = the server had no audio; the phone reads `text` aloud itself.
  | { t: 'speak'; id: number; text: string; audioPath: string | null }
  // The server picks the picture size, so it can be tuned without rebuilding the app.
  | { t: 'camera-start'; id: number; url: string; fps: number; width: number; height: number; bitrate: number }
  | { t: 'camera-stop'; id: number };

export type DownMessage =
  | DownRequest
  | { t: 'welcome' }
  | { t: 'refused'; reason: string }
  | { t: 'mic'; on: boolean }
  | { t: 'stop-audio' }
  | { t: 'state'; state: PanelState };

// ── the profile editor (HTTP, /webview/profile — profile-api.ts) ─────────────
// GET answers a ProfileView; POST {key, value} saves one need (null removes
// it) and answers the fresh view; POST …/reset puts the fixture profile back.

export type NeedKind = 'toggle' | 'choice' | 'range';

export interface ProfileNeedView {
  key: string;
  label: string;
  help: string;
  // 'other': a dimension the store holds but this app has no control for —
  // shown as it is, removable, never edited blind.
  kind: NeedKind | 'other';
  value: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  strength?: string;
  source?: string;
  // What this need switches on, in plain words (the lines that vanish from
  // ProfileView.effect when it is removed).
  effect?: string[];
}

export interface ProfileAvailableView {
  key: string;
  label: string;
  help: string;
  kind: NeedKind;
  default: boolean | string | number;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface ProfileView {
  mode: GuideModeWire;
  // Whether the running session is adapting to this profile right now.
  profileOn: boolean;
  supportAreas: string[];
  needs: ProfileNeedView[];
  // Needs the app understands that the profile does not set yet.
  available: ProfileAvailableView[];
  // What the guide will do with this profile in toolkit mode — the surface's
  // answer, in a few plain words, so an edit shows its effect at once.
  effect: string[];
}
