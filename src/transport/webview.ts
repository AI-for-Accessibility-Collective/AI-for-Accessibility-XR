// The phone-facing dashboard, mounted on the Mentra AppServer's Express app.
//
// MentraOS opens an app's dashboard via a `/webview` endpoint on the app's
// PUBLIC URL — the same AppServer/port MentraOS Cloud already proxies. The
// standalone Bun demo (demo-server.ts) lives on its own port and is
// unreachable from the phone, so this module re-exposes the SAME controls on
// the AppServer: power, the A/B mode toggle, Done/Repeat, the consent card,
// and the activity log.
//
// Trimmed on copy from the old draft: onboarding routes, skill chips,
// environmental-gate settings and the noise meter are gone. demo.html is
// still servable under the mount for a screen-shareable big view — its
// absolute endpoint paths are rewritten to the `/webview` prefix at serve
// time, keeping clear of the SDK-reserved routes (/health, POST /settings,
// /tool, /webhook, /photo-upload, /mentra-auth).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FrameStore } from './frames.ts';
import type { DemoEvent, DemoSource } from './demo-server.ts';
import type { SessionState, GuideMode } from '../runtime/session.ts';

const MOUNT = '/webview';

// Minimal structural type for the AppServer's Express app — just the methods
// we use (the SDK types Express req/res as `any` too).
type RouteHandler = (req: any, res: any) => void;
export interface ExpressLike {
  get(path: string | string[], handler: RouteHandler): unknown;
  post(path: string | string[], handler: RouteHandler): unknown;
}

export interface WebviewOptions {
  app: ExpressLike;
  frames: FrameStore;
  source: DemoSource;
  sessionState: () => SessionState;
  tts?: (text: string) => Promise<{ audio: Uint8Array; mime: string } | null>;
  streamFps?: number;
  onReset?: () => Promise<void> | void;
}

export interface WebviewHandle {
  emit: (e: DemoEvent) => void;
  update: (
    partial: Partial<{
      onSay: (text: string) => void;
      source: DemoSource;
      onSetActive: (active: boolean) => void;
      onSetMode: (mode: GuideMode) => void | Promise<void>;
      onConsent: (response: 'accept' | 'declineOnce') => void | Promise<void>;
      active: boolean;
    }>,
  ) => void;
}

function loadPanelHtml(): string {
  return readFileSync(fileURLToPath(new URL('./webview-panel.html', import.meta.url)), 'utf8');
}

// demo.html requests absolute paths (/events, /stream.mjpg, …); rewrite each
// to `${MOUNT}/…` so it runs under the prefix on the AppServer. Anchored on
// the opening quote so `/frame` (POST) doesn't clobber `/frame.jpg`.
const DEMO_ROUTES = ['frame\\.jpg', 'stream\\.mjpg', 'events', 'say', 'status', 'active', 'tts', 'reset', 'mode', 'consent', 'source', 'shutdown', 'frame'];
const DEMO_REWRITE = new RegExp(`(['"])/(?=(?:${DEMO_ROUTES.join('|')})\\b)`, 'g');
function loadDemoHtml(): string {
  const raw = readFileSync(fileURLToPath(new URL('./demo.html', import.meta.url)), 'utf8');
  return raw.replace(DEMO_REWRITE, `$1${MOUNT}/`);
}

export function mountWebview(opts: WebviewOptions): WebviewHandle {
  const { app, frames } = opts;
  const html = loadPanelHtml();
  const demoHtml = loadDemoHtml();
  const streamFps = Math.max(1, opts.streamFps ?? 8);
  const frameIntervalMs = Math.max(50, Math.round(1000 / streamFps));

  // Live context (repointed per glasses session via the returned update()).
  let onSay: (text: string) => void = () => {};
  let source: DemoSource = opts.source;
  let onSetActive: ((active: boolean) => void) | undefined;
  let onSetMode: ((mode: GuideMode) => void | Promise<void>) | undefined;
  let onConsent: ((response: 'accept' | 'declineOnce') => void | Promise<void>) | undefined;
  let active = false;

  // SSE fan-out + a small ring so a freshly-opened page gets recent context.
  const sseClients = new Set<any>();
  const recent: DemoEvent[] = [];
  const sseChunk = (e: DemoEvent): string => `data: ${JSON.stringify(e)}\n\n`;

  function emit(e: DemoEvent): void {
    recent.push(e);
    if (recent.length > 50) recent.shift();
    const chunk = sseChunk(e);
    for (const res of [...sseClients]) {
      try {
        res.write(chunk);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  setInterval(() => {
    for (const res of [...sseClients]) {
      try {
        res.write(': ping\n\n');
      } catch {
        sseClients.delete(res);
      }
    }
  }, 20000).unref?.();

  // ---- the control panel page ----
  app.get([MOUNT, `${MOUNT}/`], (_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // ---- the richer screen-shareable demo view ----
  app.get([`${MOUNT}/demo`, `${MOUNT}/demo/`], (_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(demoHtml);
  });

  // ---- live MJPEG feed of the shared FrameStore ----
  app.get(`${MOUNT}/stream.mjpg`, (req: any, res: any) => {
    const boundary = 'wearableframe';
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    const timer = setInterval(() => {
      const jpeg = frames.latest();
      if (!jpeg) return;
      try {
        res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n');
      } catch {
        clearInterval(timer);
      }
    }, frameIntervalMs);
    req.on('close', () => clearInterval(timer));
  });

  // ---- single latest frame ----
  app.get(`${MOUNT}/frame.jpg`, (_req: any, res: any) => {
    const jpeg = frames.latest();
    if (!jpeg) {
      res.status(404).send('No frame yet');
      return;
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(jpeg);
  });

  // ---- session events as Server-Sent Events ----
  app.get(`${MOUNT}/events`, (req: any, res: any) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    for (const e of recent) res.write(sseChunk(e));
    res.write(
      sseChunk({ type: 'status', text: `source=${source} mode=${opts.sessionState().mode}`, ts: Date.now() }),
    );
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ---- status: feed + session state ----
  app.get(`${MOUNT}/status`, (_req: any, res: any) => {
    res.json({
      source,
      frames: frames.size,
      acceptBrowserCam: false, // the glasses camera is the source here
      active,
      canSetMode: !!onSetMode,
      canReset: !!opts.onReset,
      state: opts.sessionState(),
    });
  });

  // ---- the A/B mode toggle ----
  app.post(`${MOUNT}/mode`, async (req: any, res: any) => {
    if (!onSetMode) {
      res.status(409).send('mode not settable');
      return;
    }
    const mode = req.body?.mode;
    if (mode !== 'baseline' && mode !== 'toolkit') {
      res.status(400).send('bad mode');
      return;
    }
    await onSetMode(mode);
    res.status(204).end();
  });

  // ---- a consent-card tap ----
  app.post(`${MOUNT}/consent`, async (req: any, res: any) => {
    if (!onConsent) {
      res.status(409).send('consent not wired');
      return;
    }
    const response = req.body?.response;
    if (response !== 'accept' && response !== 'declineOnce') {
      res.status(400).send('bad response');
      return;
    }
    await onConsent(response);
    res.status(204).end();
  });

  // ---- the retake button ----
  app.post(`${MOUNT}/reset`, async (_req: any, res: any) => {
    if (!opts.onReset) {
      res.status(409).send('reset not available');
      return;
    }
    try {
      await opts.onReset();
      res.status(204).end();
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- speak a line through the dashboard speaker (Gemini TTS) ----
  app.get(`${MOUNT}/tts`, async (req: any, res: any) => {
    if (!opts.tts) {
      res.status(409).send('tts disabled');
      return;
    }
    const text = String(req.query.text ?? '').trim();
    if (!text) {
      res.status(400).send('no text');
      return;
    }
    const out = await opts.tts(text);
    if (!out) {
      res.status(502).send('tts failed');
      return;
    }
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(out.audio));
  });

  // ---- typed/spoken utterance from the dashboard ----
  app.post(`${MOUNT}/say`, (req: any, res: any) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (text) onSay(text);
    res.status(204).end();
  });

  // ---- start/stop (panel power button) ----
  app.post(`${MOUNT}/active`, (req: any, res: any) => {
    active = !!req.body?.active;
    onSetActive?.(active);
    res.status(204).end();
  });

  console.log(`  [webview] dashboard mounted at ${MOUNT} on the Mentra app server`);

  return {
    emit,
    update: (partial) => {
      if (partial.onSay) onSay = partial.onSay;
      if (partial.source) source = partial.source;
      if (partial.onSetActive) onSetActive = partial.onSetActive;
      if (partial.onSetMode) onSetMode = partial.onSetMode;
      if (partial.onConsent) onConsent = partial.onConsent;
      if (typeof partial.active === 'boolean') active = partial.active;
    },
  };
}
