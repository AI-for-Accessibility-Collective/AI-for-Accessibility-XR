// The Mentra I/O layer — the ONLY file that imports @mentra/sdk.
//
// It does exactly four things via the AppSession:
//   - startCameraStream : ask the glasses to publish RTMP to us
//   - onFinalTranscript : mic -> text (Mentra native STT)
//   - speak             : text -> glasses speaker (Mentra TTS = ElevenLabs)
//   - showText          : text -> glasses HUD
//
// Copied from the old draft's wearable parts bin with ONE change: speak() now
// passes SpeakOptions through to session.audio.speak — the ElevenLabs knobs
// (voice_settings.speed/stability/style, voice_id, volume) that
// src/audio/elevenlabs-map.ts derives from the delivery render. The draft
// never forwarded them; this line is what makes the render audible on-device.

import type { AppSession } from '@mentra/sdk';
import { getPublishUrl } from './rtmp.ts';

// Structurally identical to @mentra/sdk's SpeakOptions; declared here so the
// Mentra-agnostic audio layer can build these objects without importing the SDK.
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

export function speak(session: AppSession, text: string, opts?: SpeakOptions): Promise<void> {
  return session.audio.speak(text, opts) as unknown as Promise<void>;
}

export function showText(session: AppSession, text: string): void {
  session.layouts.showTextWall(text);
}

// Subscribe to finalized transcripts. Returns an unsubscribe function.
export function onFinalTranscript(session: AppSession, cb: (text: string) => void): () => void {
  return session.events.onTranscription((data: { text: string; isFinal: boolean }) => {
    if (data.isFinal && data.text?.trim()) cb(data.text.trim());
  });
}

export interface CameraStreamOptions {
  rtmpHost: string;
  rtmpPort: number;
  frameRate: number;
  onStatus?: (status: string, detail?: string) => void;
}

// Tell the glasses to start publishing their camera to our local RTMP server.
// Retries because the first attempt often races the glasses' camera bring-up.
export async function startCameraStream(
  session: AppSession,
  opts: CameraStreamOptions,
): Promise<{ stop: () => void }> {
  const MAX_RETRIES = 5;
  const RETRY_DELAY = 5000;
  const rtmpUrl = getPublishUrl(opts.rtmpHost, opts.rtmpPort);
  let started = false;

  const cleanupStatus = session.camera.onStreamStatus((status: any) => {
    opts.onStatus?.(status.status, status.errorDetails);
    if ((status.status === 'streaming' || status.status === 'active') && !started) {
      started = true;
    }
  });

  try {
    await session.camera.stopStream();
  } catch {
    /* no existing stream — fine */
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      opts.onStatus?.('retrying', `attempt ${attempt}/${MAX_RETRIES}`);
      await session.camera.startStream({
        rtmpUrl,
        video: { width: 1920, height: 1080, bitrate: 5_000_000, frameRate: opts.frameRate },
        audio: { bitrate: 128_000, sampleRate: 44_100 },
      });
      started = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStatus?.('error', msg);
      if (msg.includes('not connected')) break;
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY));
    }
  }

  if (!started) {
    cleanupStatus();
    throw new Error('could not start RTMP camera stream from glasses');
  }

  return {
    stop: () => {
      cleanupStatus();
      session.camera.stopStream().catch(() => {});
    },
  };
}
