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
import type { DownMessage, GuideModeWire, PanelState, UpMessage } from '../../src/transport/phone-protocol.ts';

const PHONE_WS_PATH = '/phone'; // = PHONE_WS_PATH in phone-protocol.ts (a type-only import can't carry it)

export const SERVER_URL = (process.env.EXPO_PUBLIC_SERVER_URL || 'https://a11y.attunemitserver.dev').replace(/\/+$/, '');
const TOKEN = process.env.EXPO_PUBLIC_BRIDGE_TOKEN || '';

const PING_MS = 20_000;
const RECONNECT_MS = [1000, 2000, 5000, 10_000];

export type ServerStatus = 'connecting' | 'connected' | 'refused' | 'offline';

export interface GuideLink {
  server: ServerStatus;
  serverDetail: string;
  panel: PanelState | null;
  setActive: (on: boolean) => void;
  setMode: (mode: GuideModeWire) => void;
  say: (text: string) => void;
}

export function useGuideLink(glasses: { connected: boolean; wifi: boolean | null }): GuideLink {
  const [server, setServer] = useState<ServerStatus>('connecting');
  const [serverDetail, setServerDetail] = useState('');
  const [panel, setPanel] = useState<PanelState | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const welcomedRef = useRef(false);
  const micOnRef = useRef(false);
  const playingRef = useRef(false);
  const playerRef = useRef<AudioPlayer | null>(null);
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
  const stopAudio = useCallback((): void => {
    playerRef.current?.remove();
    playerRef.current = null;
    void Speech.stop();
    playingRef.current = false;
    void BluetoothSdk.setOwnAppAudioPlaying(false).catch(() => {});
  }, []);

  // Resolves when the line has finished playing (or was stopped).
  const speak = useCallback(
    (text: string, audioPath: string | null): Promise<void> =>
      new Promise<void>((resolve) => {
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
          if (playerRef.current === player) {
            player?.remove();
            playerRef.current = null;
          }
          playingRef.current = false;
          void BluetoothSdk.setOwnAppAudioPlaying(false).catch(() => {});
          resolve();
        };
        // A clip that never reports its end must not block the guide forever.
        const guard = setTimeout(finish, 80_000);

        let player: AudioPlayer | null = null;
        if (!audioPath) {
          Speech.speak(text, { onDone: finish, onStopped: finish, onError: finish });
          return;
        }
        player = createAudioPlayer({ uri: SERVER_URL + audioPath }, { updateInterval: 200 });
        playerRef.current = player;
        player.addListener('playbackStatusUpdate', (status) => {
          if (status.didJustFinish) finish();
        });
        player.play();
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
          setCue(m.state.active && m.state.phase === 'thinking' && !playingRef.current);
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
          void speak(m.text, m.audioPath).then(() => reply(m.id, true));
          break;
        case 'stop-audio':
          stopAudio();
          break;
        case 'camera-start':
          BluetoothSdk.startStream({
            type: 'start_stream',
            streamUrl: m.url,
            video: { fps: m.fps, width: m.width, height: m.height, bitrate: m.bitrate },
            sound: false,
          }).then(
            () => {
              setCameraLight(true);
              reply(m.id, true);
            },
            (e: unknown) => reply(m.id, false, e instanceof Error ? e.message : String(e)),
          );
          break;
        case 'camera-stop':
          setCameraLight(false);
          void BluetoothSdk.stopStream().catch(() => {});
          break;
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

  return {
    server,
    serverDetail,
    panel,
    setActive: (on) => send({ t: 'control', action: 'active', value: on }),
    setMode: (mode) => send({ t: 'control', action: 'mode', value: mode }),
    say: (text) => send({ t: 'control', action: 'say', value: text }),
  };
}
