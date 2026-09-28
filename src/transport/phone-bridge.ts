// The server end of the phone link (see phone-protocol.ts). One HTTP server on
// PORT carries three things: the Express app the phone panel mounts on
// (/webview), the WebSocket the phone app connects to (/phone), and the
// one-shot audio clips the phone plays through the glasses (/phone/audio/…),
// plus the frames behind the app's Debug section (/phone/frames-used/…).
//
// This replaces the @mentra/sdk AppServer. MentraOS Cloud no longer calls us;
// the phone app dials in, so there is no webhook, package name or API key —
// the shared BRIDGE_TOKEN is what stops a stranger from driving the guide.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PHONE_WS_PATH,
  type DownMessage,
  type DownRequest,
  type FramesUsed,
  type GuideModeWire,
  type PanelState,
  type UpMessage,
} from './phone-protocol.ts';

// A reply that never comes (phone locked, link half-dead) must not hang a take.
const SPEAK_TIMEOUT_MS = 90_000;
const CAMERA_TIMEOUT_MS = 30_000;
const CLIP_TTL_MS = 120_000;
// Debug frames are kept for the last few model calls only: the app shows the
// newest, and one still being fetched must not vanish under it.
const FRAMES_USED_KEPT = 3;
// The phone pings every 20 s; two missed pings and the link is gone.
const LINK_DEAD_MS = 50_000;

export interface PhoneLink {
  readonly id: string;
  glasses: { connected: boolean; wifi: boolean | null };
  // Play one spoken line through the glasses; resolves when it has finished.
  // Without a clip the phone falls back to its own text-to-speech.
  // Resolves with the phone's own timing: ms from being told to first sound, and ms of playback.
  speak(text: string, clip: { audio: Uint8Array; mime: string; ext: string } | null): Promise<{ loadMs: number; playMs: number }>;
  stopAudio(): void;
  // Tell the glasses to publish their camera to `url`. Rejects if they refuse.
  startCamera(url: string, video: { fps: number; width: number; height: number; bitrate: number }): Promise<void>;
  stopCamera(): void;
  setMic(on: boolean): void;
  sendState(state: PanelState): void;
  // Debug: show the app which camera frames just went to the model.
  sendFramesUsed(what: string, frames: Array<{ jpeg: Buffer; timestamp: number }>): void;
  send(m: DownMessage): void;
}

export interface PhoneBridgeHandlers {
  onLink(link: PhoneLink): void;
  onUnlink(link: PhoneLink): void;
  onGlasses(link: PhoneLink): void;
  onMicAudio(link: PhoneLink, pcm: Buffer): void;
  onSetActive(link: PhoneLink, on: boolean): void;
  onSetMode(link: PhoneLink, mode: GuideModeWire): void;
  onSay(link: PhoneLink, text: string): void;
  // The spoken setup: begin it, or end it early. Optional, so a host without
  // one simply ignores the control.
  onOnboarding?(link: PhoneLink, action: 'start' | 'cancel'): void;
  onCalibrateBegin(link: PhoneLink): void;
  onCalibrateFlashes(link: PhoneLink, at: number[], flashMs: number): void;
}

export interface PhoneBridge {
  app: Express;
  listen(port: number): Promise<void>;
  close(): void;
}

// iOS's media player opens every file by asking for its first two bytes, and
// refuses to play if it gets the whole file back instead — so byte ranges are
// not optional for anything the phone plays.
function sendAudio(req: IncomingMessage, res: ServerResponse, wav: Uint8Array, mime: string): void {
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  const total = wav.byteLength;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (!range || (range[1] === '' && range[2] === '')) {
    res.setHeader('Content-Length', String(total));
    return void res.end(Buffer.from(wav.buffer, wav.byteOffset, total));
  }
  // "a-b", "a-" (from a to the end) or "-n" (the last n bytes).
  const start = range[1] === '' ? Math.max(0, total - Number(range[2])) : Number(range[1]);
  const end = range[1] === '' || range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1);
  if (start > end || start >= total) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${total}`);
    return void res.end();
  }
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', String(end - start + 1));
  res.end(Buffer.from(wav.buffer, wav.byteOffset + start, end - start + 1));
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPhoneBridge(opts: { token: string; handlers: PhoneBridgeHandlers }): PhoneBridge {
  const { token, handlers } = opts;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => void res.json({ status: 'ok', phone: current != null }));

  // Spoken lines waiting to be fetched. Ids are random, single-purpose and
  // short-lived, so the path itself is the credential.
  const clips = new Map<string, { audio: Uint8Array; mime: string }>();
  app.get('/phone/audio/:id', (req, res) => {
    const clip = clips.get(String(req.params.id).replace(/\.(wav|aac)$/, ''));
    if (!clip) return void res.status(404).end();
    res.setHeader('Cache-Control', 'no-store');
    sendAudio(req, res, clip.audio, clip.mime);
  });

  // The frames behind the app's Debug section. Same rule as the clips: the
  // random id in the path is the credential.
  const framesUsed: Array<{ id: string; jpegs: Buffer[] }> = [];
  app.get('/phone/frames-used/:id/:n', (req, res) => {
    const jpeg = framesUsed.find((u) => u.id === req.params.id)?.jpegs[Number(String(req.params.n).replace(/\.jpg$/, ''))];
    if (!jpeg) return void res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(jpeg);
  });

  // The little sounds the phone plays on its own cue (see phone/src/useGuideLink.ts).
  // Served from here rather than built into the app so they can be retuned
  // without reinstalling it.
  const sounds = new Map<string, Buffer>();
  app.get('/phone/sounds/:name', (req, res) => {
    const name = String(req.params.name);
    if (!/^[a-z-]{1,32}\.wav$/.test(name)) return void res.status(404).end();
    let wav = sounds.get(name);
    if (!wav) {
      try {
        wav = readFileSync(fileURLToPath(new URL(`./sounds/${name}`, import.meta.url)));
        sounds.set(name, wav);
      } catch {
        return void res.status(404).end();
      }
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    sendAudio(req, res, wav, 'audio/wav');
  });

  const server: Server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== PHONE_WS_PATH) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // One wearer, one phone: a new phone replaces the old link.
  let current: { link: PhoneLink; ws: WebSocket } | null = null;

  wss.on('connection', (ws: WebSocket) => {
    let link: PhoneLink | null = null;
    let nextId = 1;
    const waiting = new Map<number, { resolve: (detail?: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let lastSeen = Date.now();

    const send = (m: DownMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const request = (m: DownRequest, timeoutMs: number): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(m.id);
          reject(new Error(`phone did not answer "${m.t}" in ${timeoutMs / 1000}s`));
        }, timeoutMs);
        waiting.set(m.id, { resolve, reject, timer });
        send(m);
      });

    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > LINK_DEAD_MS) ws.terminate();
    }, 10_000);

    ws.on('message', (data, isBinary) => {
      lastSeen = Date.now();
      if (isBinary) {
        if (link) handlers.onMicAudio(link, data as Buffer);
        return;
      }
      let m: UpMessage;
      try {
        m = JSON.parse(String(data)) as UpMessage;
      } catch {
        return;
      }

      if (!link) {
        if (m.t !== 'hello') return;
        if (!token || !tokenMatches(m.token || '', token)) {
          send({ t: 'refused', reason: token ? 'wrong token' : 'the server has no BRIDGE_TOKEN set' });
          console.warn('[phone] refused a connection: bad token');
          return void ws.close(4401, 'unauthorized');
        }
        if (current) current.ws.close(4000, 'replaced by a newer phone connection');
        link = {
          id: randomUUID().slice(0, 8),
          glasses: { connected: false, wifi: null },
          async speak(text, clip) {
            let audioPath: string | null = null;
            if (clip) {
              const clipId = randomUUID();
              clips.set(clipId, { audio: clip.audio, mime: clip.mime });
              setTimeout(() => clips.delete(clipId), CLIP_TTL_MS);
              audioPath = `/phone/audio/${clipId}.${clip.ext}`;
            }
            const tSent = Date.now();
            const detail = await request({ t: 'speak', id: nextId++, text, audioPath }, SPEAK_TIMEOUT_MS);
            let timing: { loadMs?: number; playMs?: number } = {};
            try {
              timing = detail ? JSON.parse(detail) : {};
            } catch {
              /* an older app answers with no timing */
            }
            return { loadMs: timing.loadMs ?? 0, playMs: timing.playMs ?? Date.now() - tSent };
          },
          stopAudio: () => send({ t: 'stop-audio' }),
          startCamera: (url, video) => request({ t: 'camera-start', id: nextId++, url, ...video }, CAMERA_TIMEOUT_MS).then(() => undefined),
          stopCamera: () => send({ t: 'camera-stop', id: nextId++ }),
          setMic: (on) => send({ t: 'mic', on }),
          sendState: (state) => send({ t: 'state', state }),
          send,
          sendFramesUsed(what, frames) {
            const id = randomUUID();
            framesUsed.push({ id, jpegs: frames.map((f) => f.jpeg) });
            while (framesUsed.length > FRAMES_USED_KEPT) framesUsed.shift();
            const used: FramesUsed = {
              what,
              at: Date.now(),
              frames: frames.map((f, n) => ({ path: `/phone/frames-used/${id}/${n}.jpg`, takenAt: f.timestamp })),
            };
            send({ t: 'frames-used', used });
          },
        };
        current = { link, ws };
        send({ t: 'welcome' });
        console.log(`[phone] ${m.app || 'phone app'} connected (link ${link.id})`);
        handlers.onLink(link);
        return;
      }

      switch (m.t) {
        case 'glasses':
          link.glasses = { connected: m.connected, wifi: m.wifi };
          handlers.onGlasses(link);
          break;
        case 'control':
          if (m.action === 'active') handlers.onSetActive(link, !!m.value);
          else if (m.action === 'mode' && (m.value === 'baseline' || m.value === 'toolkit')) handlers.onSetMode(link, m.value);
          else if (m.action === 'say' && typeof m.value === 'string' && m.value.trim()) handlers.onSay(link, m.value.trim());
          else if (m.action === 'onboarding' && (m.value === 'start' || m.value === 'cancel')) handlers.onOnboarding?.(link, m.value);
          break;
        case 'camera-status':
          console.log(`[camera] glasses report: ${String(m.status)}${m.detail ? ` — ${String(m.detail).slice(0, 200)}` : ''}`);
          break;
        case 'clock':
          send({ t: 'clock', at: m.at, now: Date.now() });
          break;
        case 'calibrate':
          if (m.step === 'begin') handlers.onCalibrateBegin(link);
          else if (Array.isArray(m.at) && m.at.every((v) => typeof v === 'number')) handlers.onCalibrateFlashes(link, m.at, Number(m.flashMs) || 500);
          break;
        case 'reply': {
          const w = waiting.get(m.id);
          if (!w) break;
          waiting.delete(m.id);
          clearTimeout(w.timer);
          if (m.ok) w.resolve(m.detail);
          else w.reject(new Error(m.detail || 'the phone reported a failure'));
          break;
        }
        default:
          break; // 'ping' only refreshes lastSeen
      }
    });

    ws.on('close', () => {
      clearInterval(watchdog);
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error('phone disconnected'));
      }
      waiting.clear();
      if (!link) return;
      if (current?.link === link) current = null;
      console.log(`[phone] disconnected (link ${link.id})`);
      handlers.onUnlink(link);
    });
    ws.on('error', () => ws.terminate());
  });

  return {
    app,
    listen: (port) => new Promise<void>((resolve) => server.listen(port, resolve)),
    close: () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
    },
  };
}
