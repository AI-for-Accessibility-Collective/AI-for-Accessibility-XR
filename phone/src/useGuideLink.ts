// The phone's whole job: hold the Bluetooth link to the glasses (Mentra
// Bluetooth SDK) and relay between them and the guide server over one
// WebSocket (../../src/transport/phone-protocol.ts).
//
//   glasses mic  ──PCM──▶  server            (only while the guide is on, and
//                                             never while it is speaking)
//   server  ──audio clip──▶  phone plays it ──▶ glasses speaker (the phone's
//                                             normal Bluetooth audio route)
//   server  ──"camera-start"──▶  glasses publish RTMP straight to the server

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';
import BluetoothSdk from '@mentra/bluetooth-sdk';
import type { DownMessage, FramesUsed, GuideModeWire, PanelState, UpMessage } from '../../src/transport/phone-protocol.ts';

const PHONE_WS_PATH = '/phone'; // = PHONE_WS_PATH in phone-protocol.ts (a type-only import can't carry it)

export const SERVER_URL = (process.env.EXPO_PUBLIC_SERVER_URL || 'https://a11y.attunemitserver.dev').replace(/\/+$/, '');
const TOKEN = process.env.EXPO_PUBLIC_BRIDGE_TOKEN || '';

const PING_MS = 20_000;
const RECONNECT_MS = [1000, 2000, 5000, 10_000];

export type ServerStatus = 'connecting' | 'connected' | 'refused' | 'offline';

export interface LagCheck {
  ok: boolean;
  videoMs?: number;
  lagMs?: number;
  samples?: number;
  spreadMs?: number;
  reason?: string;
}

const FLASHES = 6;
const FLASH_MS = 600;

export interface GuideLink {
  // Measures how far the camera runs behind, by flashing the screen (the
  // caller shows white while `flash(true)`) with the glasses pointed at it.
  checkCameraTiming: (flash: (on: boolean) => void, progress: (text: string) => void) => Promise<LagCheck>;
  server: ServerStatus;
  serverDetail: string;
  panel: PanelState | null;
  // Debug: the camera frames behind the turn the guide is working on (or last did).
  framesUsed: FramesUsed | null;
  setActive: (on: boolean) => void;
  setMode: (mode: GuideModeWire) => void;
  say: (text: string) => void;
  // The spoken setup: begin it, or end it early (what was chosen is kept).
  onboarding: (action: 'start' | 'cancel') => void;
}

export function useGuideLink(glasses: { connected: boolean; wifi: boolean | null }): GuideLink {
  const [server, setServer] = useState<ServerStatus>('connecting');
  const [serverDetail, setServerDetail] = useState('');
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [framesUsed, setFramesUsed] = useState<FramesUsed | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const welcomedRef = useRef(false);
  const micOnRef = useRef(false);
  const playingRef = useRef(false);
  const playerRef = useRef<AudioPlayer | null>(null);
  // Server clock − phone clock, from the quickest of a few round trips.
  const clockRef = useRef<{ offset: number; rtt: number } | null>(null);
  const waitersRef = useRef<{ ready?: (m: { ready: boolean; reason?: string }) => void; done?: (m: LagCheck) => void }>({});
  const stoppingRef = useRef<Promise<void> | null>(null);
  const cueRef = useRef<AudioPlayer | null>(null);
  const cueOnRef = useRef(false);
  const ledTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const glassesRef = useRef(glasses);
  glassesRef.current = glasses;

  const send = useCallback((m: UpMessage): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && (welcomedRef.current || m.t === 'hello')) ws.send(JSON.stringify(m));
  }, []);

  // ── "Working on it" sound ─────────────────────────────────────────────────
  // A quiet loop while the guide is thinking, so silence never reads as
  // "it didn't hear me". The file lives on the server (/phone/sounds) so it can
  // be retuned without reinstalling the app.
  // Fades in and out over a few hundred ms: a cue that snaps on and off
  // feels like an alarm; one that swells in and ebbs away feels like the guide
  // is working.
  const cueFadeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fadeCue = (to: number, ms: number, then?: () => void): void => {
    const cue = cueRef.current;
    if (cueFadeRef.current) clearInterval(cueFadeRef.current);
    if (!cue) return;
    const from = cue.volume;
    const steps = Math.max(1, Math.round(ms / 40));
    let i = 0;
    cueFadeRef.current = setInterval(() => {
      i++;
      cue.volume = from + ((to - from) * i) / steps;
      if (i >= steps) {
        if (cueFadeRef.current) clearInterval(cueFadeRef.current);
        cueFadeRef.current = null;
        then?.();
      }
    }, 40);
  };
  const setCue = useCallback((on: boolean): void => {
    if (on === cueOnRef.current) return;
    cueOnRef.current = on;
    try {
      if (on) {
        if (!cueRef.current) {
          const cue = createAudioPlayer({ uri: `${SERVER_URL}/phone/sounds/thinking.wav` });
          cue.loop = true;
          cueRef.current = cue;
        }
        cueRef.current.volume = 0;
        void cueRef.current.seekTo(0);
        cueRef.current.play();
        fadeCue(0.6, 400);
      } else {
        fadeCue(0, 350, () => cueRef.current?.pause());
      }
    } catch (e) {
      console.warn('thinking sound failed', e);
    }
  }, []);

  // ── Camera light ──────────────────────────────────────────────────────────
  // The glasses' RGB LED shows green for as long as the camera is streaming,
  // so the wearer can see it is on. A "solid" LED command lasts 30 s, so it is
  // renewed just before it lapses (the pattern Mentra's own example uses).
  const setCameraLight = useCallback((on: boolean): void => {
    if (ledTimerRef.current) clearInterval(ledTimerRef.current);
    ledTimerRef.current = null;
    const light = (): void =>
      void BluetoothSdk.rgbLedControl(`cam-${Date.now()}`, null, 'on', 'green', 30_000, 0, 1).catch((e) => console.warn('camera light failed', e));
    if (on) {
      light();
      ledTimerRef.current = setInterval(light, 25_000);
    } else {
      void BluetoothSdk.rgbLedControl(`cam-${Date.now()}`, null, 'off', null, 0, 0, 0).catch(() => {});
    }
  }, []);

  // ── Speaking ──────────────────────────────────────────────────────────────
  // Silence, now. Every step is guarded on its own: a player that refuses to
  // be released must not leave the phone's own voice, or the flags, running.
  // The line that was playing is then reported finished, so the server is
  // never left waiting for a clip that was cut off.
  const finishRef = useRef<(() => void) | null>(null);
  const stopAudio = useCallback((): void => {
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      try {
        player.pause(); // stops the sound at once; remove() alone can let the buffer play out
      } catch {
        /* already gone */
      }
      try {
        player.remove();
      } catch {
        /* already gone */
      }
    }
    try {
      void Speech.stop();
    } catch {
      /* nothing was speaking */
    }
    playingRef.current = false;
    void BluetoothSdk.setOwnAppAudioPlaying(false).catch(() => {});
    const finish = finishRef.current;
    finishRef.current = null;
    finish?.();
  }, []);

  // Resolves when the line has finished playing (or was stopped), with how
  // long the phone took to start it and how long it played — the server
  // logs these so slow turns can be blamed on the right stage.
  const speak = useCallback(
    (text: string, audioPath: string | null): Promise<{ loadMs: number; playMs: number }> =>
      new Promise<{ loadMs: number; playMs: number }>((resolve) => {
        const t0 = Date.now();
        let tPlay = 0;
        stopAudio();
        setCue(false);
        playingRef.current = true;
        // Tells the SDK to keep the glasses mic path out of the speaker's way.
        void BluetoothSdk.setOwnAppAudioPlaying(true).catch(() => {});
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(guard);
          if (finishRef.current === finish) finishRef.current = null;
          if (playerRef.current === player) {
            try {
              player?.remove();
            } catch {
              /* already gone */
            }
            playerRef.current = null;
          }
          playingRef.current = false;
          void BluetoothSdk.setOwnAppAudioPlaying(false).catch(() => {});
          resolve({ loadMs: (tPlay || Date.now()) - t0, playMs: tPlay ? Date.now() - tPlay : 0 });
        };
        // A clip that never reports its end must not hold the guide — and it
        // happens: a clip the server no longer has, a download that stalls, a
        // player that loads and never starts. The guard is as tight as what is
        // known: a few seconds to start, then the clip's own remaining length.
        // (It was a flat 80 s, which is what "Speaking…" with nothing happening
        // looked like.)
        const START_GRACE_MS = 8000;
        const END_GRACE_MS = 3000;
        let guard = setTimeout(finish, START_GRACE_MS);
        const armGuard = (ms: number): void => {
          clearTimeout(guard);
          guard = setTimeout(finish, ms);
        };
        finishRef.current = finish;

        let player: AudioPlayer | null = null;
        if (!audioPath) {
          // The phone's own voice: about 2.5 words a second, plus some grace.
          armGuard(START_GRACE_MS + (text.split(/\s+/).length / 2.5) * 1000);
          Speech.speak(text, {
            onStart: () => {
              tPlay = Date.now();
            },
            onDone: finish,
            onStopped: finish,
            onError: finish,
          });
          return;
        }
        try {
          player = createAudioPlayer({ uri: SERVER_URL + audioPath }, { updateInterval: 200 });
          playerRef.current = player;
          player.addListener('playbackStatusUpdate', (status) => {
            if (status.playing && !tPlay) tPlay = Date.now();
            if (status.didJustFinish) return finish();
            // Playing, or loaded and about to: give it what is left of the clip.
            if (status.playing && status.duration > 0) armGuard((status.duration - status.currentTime) * 1000 + END_GRACE_MS);
          });
          player.play();
        } catch {
          finish(); // no player at all: the line is skipped, not waited for
        }
      }),
    [stopAudio, setCue],
  );

  // ── Server connection ─────────────────────────────────────────────────────
  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;

    // A plain playback session, on purpose. The glasses are a Bluetooth *media*
    // output (A2DP, like headphones). Asking iOS for a recording session here
    // (allowsRecording) switches it to play-and-record, which only allows
    // hands-free-call Bluetooth — and the guide's voice never reaches the
    // glasses. We never record with the phone: glasses mic audio arrives as
    // data through the SDK.
    void setAudioModeAsync({
      allowsRecording: false,
      shouldPlayInBackground: true,
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
    }).catch((e) => console.warn('audio mode failed', e));

    const reply = (id: number, ok: boolean, detail?: string): void => send({ t: 'reply', id, ok, detail });

    const onMessage = (m: DownMessage): void => {
      switch (m.t) {
        case 'welcome':
          welcomedRef.current = true;
          attempt = 0;
          setServer('connected');
          setServerDetail('');
          send({ t: 'glasses', ...glassesRef.current });
          break;
        case 'refused':
          setServer('refused');
          setServerDetail(m.reason);
          break;
        case 'state':
          setPanel(m.state);
          if (!m.state.active && (playingRef.current || playerRef.current)) stopAudio();
          // The server says when: after the spoken acknowledgement, never under it.
          setCue((m.state.cue ?? (m.state.active && m.state.phase === 'thinking')) && !playingRef.current);
          break;
        case 'frames-used':
          setFramesUsed(m.used);
          break;
        case 'clock': {
          const rtt = Date.now() - m.at;
          if (!clockRef.current || rtt < clockRef.current.rtt) clockRef.current = { rtt, offset: m.now + rtt / 2 - Date.now() };
          break;
        }
        case 'calibrate':
          waitersRef.current.ready?.(m);
          break;
        case 'calibrated':
          waitersRef.current.done?.(m);
          break;
        case 'mic':
          micOnRef.current = m.on;
          void (async () => {
            if (m.on) {
              // Continuous audio with quiet input gated to silence — what the
              // server's utterance detector expects (src/engine/stt.ts).
              await BluetoothSdk.setVoiceActivityDetectionEnabled(false).catch(() => {});
              await BluetoothSdk.setLoudnessGateEnabled(true).catch(() => {});
            }
            await BluetoothSdk.setMicState(m.on, true).catch((e) => console.warn('setMicState failed', e));
          })();
          break;
        case 'speak':
          void speak(m.text, m.audioPath).then((timing) => reply(m.id, true, JSON.stringify(timing)));
          break;
        case 'stop-audio':
          stopAudio();
          break;
        case 'camera-start':
          // The glasses run one stream, and a start that lands while a stop is
          // still being carried out is refused ("preempted"). So: stop first,
          // wait for it, then start.
          (stoppingRef.current ?? Promise.resolve())
            .then(() =>
              BluetoothSdk.startStream({
                type: 'start_stream',
                streamUrl: m.url,
                video: { fps: m.fps, width: m.width, height: m.height, bitrate: m.bitrate },
                sound: false,
              }),
            )
            .then(
            () => {
              setCameraLight(true);
              reply(m.id, true);
            },
            (e: unknown) => reply(m.id, false, e instanceof Error ? e.message : String(e)),
          );
          break;
        case 'camera-stop': {
          setCameraLight(false);
          const stopping = BluetoothSdk.stopStream()
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
              if (stoppingRef.current === stopping) stoppingRef.current = null;
            });
          stoppingRef.current = stopping;
          break;
        }
      }
    };

    const connect = (): void => {
      if (closed) return;
      setServer((s) => (s === 'refused' ? s : 'connecting'));
      welcomedRef.current = false;
      const ws = new WebSocket(SERVER_URL.replace(/^http/, 'ws') + PHONE_WS_PATH);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => send({ t: 'hello', token: TOKEN, app: 'Wearable Task Guide phone' });
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          onMessage(JSON.parse(ev.data) as DownMessage);
        } catch {
          /* not ours */
        }
      };
      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        welcomedRef.current = false;
        // The server turned everything off when it lost us; match it.
        micOnRef.current = false;
        stopAudio();
        setCue(false);
        setCameraLight(false);
        void BluetoothSdk.setMicState(false).catch(() => {});
        void BluetoothSdk.stopStream().catch(() => {});
        setPanel(null);
        setFramesUsed(null); // its pictures live on the server we just lost
        if (closed) return;
        if (ev.code === 4401) return; // wrong token — retrying won't help
        setServer('offline');
        setServerDetail(ev.code === 4000 ? 'another phone took over' : '');
        retry = setTimeout(connect, RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)]);
      };
      ws.onerror = () => {};
    };

    connect();
    ping = setInterval(() => send({ t: 'ping' }), PING_MS);

    // The glasses' own account of their camera stream, for the server's log.
    const streamStatus = BluetoothSdk.addListener('stream_status', (event) => {
      const e = event as { status?: string; errorDetails?: string; reason?: string; attempt?: number; maxAttempts?: number };
      const detail = e.errorDetails ?? e.reason ?? (e.attempt != null ? `attempt ${e.attempt}${e.maxAttempts ? '/' + e.maxAttempts : ''}` : undefined);
      send({ t: 'camera-status', status: String(e.status ?? 'unknown'), detail });
    });

    // Glasses mic → server, as raw binary frames.
    const mic = BluetoothSdk.addListener('mic_pcm', (event) => {
      const ws = wsRef.current;
      if (!micOnRef.current || playingRef.current || cueOnRef.current || !welcomedRef.current) return;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(event.pcm);
    });

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      mic.remove();
      streamStatus.remove();
      wsRef.current?.close();
      stopAudio();
      setCue(false);
      setCameraLight(false);
      cueRef.current?.remove();
      cueRef.current = null;
    };
  }, [send, speak, stopAudio, setCue, setCameraLight]);

  // Keep the server told about the glasses.
  useEffect(() => {
    send({ t: 'glasses', connected: glasses.connected, wifi: glasses.wifi });
  }, [send, glasses.connected, glasses.wifi]);

  const checkCameraTiming = useCallback(
    async (flash: (on: boolean) => void, progress: (text: string) => void): Promise<LagCheck> => {
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const wait = <T,>(slot: 'ready' | 'done', ms: number): Promise<T | null> =>
        new Promise<T | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), ms);
          (waitersRef.current as Record<string, unknown>)[slot] = (m: T) => {
            clearTimeout(timer);
            resolve(m);
          };
        });
      try {
        progress('Checking the clock…');
        clockRef.current = null;
        for (let i = 0; i < 6; i++) {
          send({ t: 'clock', at: Date.now() });
          await sleep(150);
        }
        await sleep(400);
        const clock = clockRef.current as { offset: number; rtt: number } | null;
        if (!clock) return { ok: false, reason: 'The guide server did not answer. Check the connection and try again.' };

        const ready = wait<{ ready: boolean; reason?: string }>('ready', 5000);
        send({ t: 'calibrate', step: 'begin' });
        const go = await ready;
        if (!go?.ready) return { ok: false, reason: go?.reason ?? 'The guide server did not answer.' };

        progress('Hold the glasses facing this screen, about a hand away.');
        await sleep(2500);
        const at: number[] = [];
        for (let i = 0; i < FLASHES; i++) {
          progress(`Flash ${i + 1} of ${FLASHES} — keep looking at the screen`);
          // Uneven gaps on purpose: only the true delay lines them all up.
          await sleep(1300 + Math.random() * 1400);
          flash(true);
          at.push(Date.now() + clock.offset);
          await sleep(FLASH_MS);
          flash(false);
        }
        progress('Working it out…');
        const done = wait<LagCheck>('done', 20_000);
        send({ t: 'calibrate', step: 'flashes', at, flashMs: FLASH_MS });
        return (await done) ?? { ok: false, reason: 'No result came back. Try again.' };
      } finally {
        flash(false);
        waitersRef.current = {};
      }
    },
    [send],
  );

  return {
    checkCameraTiming,
    server,
    serverDetail,
    panel,
    framesUsed,
    setActive: (on) => {
      if (!on) {
        // Stop means silence now — not after a round trip to the server.
        stopAudio();
        setCue(false);
        cueRef.current?.pause();
      }
      send({ t: 'control', action: 'active', value: on });
    },
    setMode: (mode) => send({ t: 'control', action: 'mode', value: mode }),
    say: (text) => send({ t: 'control', action: 'say', value: text }),
    onboarding: (action) => send({ t: 'control', action: 'onboarding', value: action }),
  };
}
