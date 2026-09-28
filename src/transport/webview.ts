// The browser control panel, mounted on the phone bridge's Express app
// (phone-bridge.ts) at /webview on the app's PUBLIC URL. Every route here is
// behind the shared guard (admin-auth.ts): it shows the glasses' live camera
// picture and its buttons drive the guide, so a browser must give
// ADMIN_PASSWORD (404 until one is set) and the phone app its BRIDGE_TOKEN.
//
// The standalone Bun demo (demo-server.ts) lives on its own port and is not
// public, so this module re-exposes the SAME controls here: power, the A/B
// mode toggle, Done/Repeat and the activity log. The phone app has its own
// copy of those controls; this panel is for a laptop or a second person.
//
// demo.html is still servable under the mount for a screen-shareable big
// view — its absolute endpoint paths are rewritten to the `/webview` prefix at
// serve time, keeping clear of the bridge's own routes (/health, /phone).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FrameStore } from './frames.ts';
import type { DemoEvent, DemoSource } from './demo-server.ts';
import type { SessionState, GuideMode } from '../runtime/session.ts';
import { createProfileApi, type ProfileApiDeps } from './profile-api.ts';
import { createGuard } from './admin-auth.ts';
import type { AdaptationTag } from '../toolkit-candidates/effect.ts';
import type { OnboardingPanel } from './phone-protocol.ts';

const MOUNT = '/webview';

// Minimal structural type for the Express app — just the methods we use.
type RouteHandler = (req: any, res: any) => void;
export interface ExpressLike {
  get(path: string | string[], handler: RouteHandler): unknown;
  post(path: string | string[], handler: RouteHandler): unknown;
}

export interface WebviewOptions {
  app: ExpressLike;
  // ADMIN_PASSWORD, for a browser (admin-auth.ts). Empty → every route 404s.
  password: string;
  // BRIDGE_TOKEN, which the phone app sends as a bearer token.
  bridgeToken?: string;
  frames: FrameStore;
  source: DemoSource;
  sessionState: () => SessionState;
  tts?: (text: string) => Promise<{ audio: Uint8Array; mime: string } | null>;
  streamFps?: number;
  // True when the password-protected run history (runs-web.ts) is on, so the
  // pages know whether to show their "Past runs" link.
  runsEnabled?: boolean;
  // The profile editor (profile-api.ts): the live store handle and the
  // session refresh, both looked up per call because the glasses app opens
  // its store per phone session. Absent → the /profile routes answer 409.
  profile?: Pick<ProfileApiDeps, 'toolkit' | 'onProfileChanged'>;
  // The spoken setup's progress for /status, looked up per call like the
  // session state. Absent (or answering null) → the pages hide their tab.
  onboardingState?: () => OnboardingPanel | null;
}

// What the panel's caption stage shows, as it happens — for someone watching a
// shared screen, who cannot hear the glasses. Sent as SSE events NAMED
// `stage`, apart from the log's unnamed ones: they are never replayed from the
// ring, and demo.html (which listens to unnamed events only) never sees them.
export type StageEvent =
  | { kind: 'phase'; phase: 'idle' | 'listening' | 'thinking' | 'speaking' }
  // on:true as a line is handed to the phone to play; on:false when it has
  // played. `tags`: the adaptations that shaped this line. `lagMs`: how long
  // the phone took to start the last clip, so the words can wait that long.
  | { kind: 'caption'; id: number; on: true; text: string; tags: AdaptationTag[]; filler: boolean; lagMs: number }
  | { kind: 'caption'; id: number; on: false };

export interface WebviewHandle {
  emit: (e: DemoEvent) => void;
  stage: (e: StageEvent) => void;
  update: (
    partial: Partial<{
      onSay: (text: string) => void;
      source: DemoSource;
      onSetActive: (active: boolean) => void;
      onSetMode: (mode: GuideMode) => void | Promise<void>;
      onOnboarding: (action: 'start' | 'cancel') => void;
      active: boolean;
    }>,
  ) => void;
}

function loadPanelHtml(): string {
  return readFileSync(fileURLToPath(new URL('./webview-panel.html', import.meta.url)), 'utf8');
}

// demo.html requests absolute paths (/events, /stream.mjpg, …); rewrite each
// to `${MOUNT}/…` so it runs under the prefix. Anchored on
// the opening quote so `/frame` (POST) doesn't clobber `/frame.jpg`.
const DEMO_ROUTES = ['frame\\.jpg', 'stream\\.mjpg', 'events', 'say', 'status', 'active', 'tts', 'mode', 'source', 'shutdown', 'frame', 'runs', 'profile', 'onboarding'];
const DEMO_REWRITE = new RegExp(`(['"])/(?=(?:${DEMO_ROUTES.join('|')})\\b)`, 'g');
function loadDemoHtml(): string {
  const raw = readFileSync(fileURLToPath(new URL('./demo.html', import.meta.url)), 'utf8');
  return raw.replace(DEMO_REWRITE, `$1${MOUNT}/`);
}

export function mountWebview(opts: WebviewOptions): WebviewHandle {
  const { frames } = opts;
  const guard = createGuard({ password: opts.password, bridgeToken: opts.bridgeToken, tag: 'webview' });
  const app: ExpressLike = {
    get: (path, handler) => opts.app.get(path, guard(handler)),
    post: (path, handler) => opts.app.post(path, guard(handler)),
  };
  const html = loadPanelHtml();
  const demoHtml = loadDemoHtml();
  const streamFps = Math.max(1, opts.streamFps ?? 8);
  const frameIntervalMs = Math.max(50, Math.round(1000 / streamFps));

  // Live context (repointed per glasses session via the returned update()).
  let onSay: (text: string) => void = () => {};
  let source: DemoSource = opts.source;
  let onSetActive: ((active: boolean) => void) | undefined;
  let onSetMode: ((mode: GuideMode) => void | Promise<void>) | undefined;
  let onOnboarding: ((action: 'start' | 'cancel') => void) | undefined;
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

  // Only the phase is kept for a page opened later; a caption is of its moment.
  let phase: StageEvent | null = null;
  const stageChunk = (e: StageEvent): string => `event: stage\ndata: ${JSON.stringify(e)}\n\n`;
  function stage(e: StageEvent): void {
    if (e.kind === 'phase') {
      if (phase?.kind === 'phase' && phase.phase === e.phase) return;
      phase = e;
    }
    const chunk = stageChunk(e);
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
    // Only a NEW picture is sent (frames.latest() hands back the same buffer
    // until the camera delivers another). Re-sending the unchanged one at the
    // stream's rate cost ~1.7 MB/s per open page for nothing. It is repeated
    // every couple of seconds so a browser or proxy never sees the stream idle.
    let lastSent: Buffer | null = null;
    let lastSentAt = 0;
    const timer = setInterval(() => {
      const jpeg = frames.latest();
      if (!jpeg) return;
      if (jpeg === lastSent && Date.now() - lastSentAt < 2000) return;
      lastSent = jpeg;
      lastSentAt = Date.now();
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
    if (phase) res.write(stageChunk(phase));
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
      runs: !!opts.runsEnabled,
      state: opts.sessionState(),
      onboarding: (onOnboarding && opts.onboardingState?.()) || null,
    });
  });

  // ---- the spoken setup: begin it, or end it early ----
  app.post(`${MOUNT}/onboarding`, (req: any, res: any) => {
    if (!onOnboarding) {
      res.status(409).send('no live session');
      return;
    }
    const action = req.body?.action;
    if (action !== 'start' && action !== 'cancel') {
      res.status(400).send('bad action');
      return;
    }
    onOnboarding(action);
    res.status(204).end();
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

  // ---- the profile editor ----
  const profileApi = createProfileApi({
    toolkit: opts.profile?.toolkit ?? (() => null),
    sessionState: opts.sessionState,
    onProfileChanged: opts.profile?.onProfileChanged,
  });
  app.get(`${MOUNT}/profile`, async (_req: any, res: any) => {
    const r = await profileApi.get();
    res.status(r.status).json(r.body);
  });
  app.post(`${MOUNT}/profile`, async (req: any, res: any) => {
    const r = await profileApi.set(req.body);
    res.status(r.status).json(r.body);
  });
  app.post(`${MOUNT}/profile/reset`, async (_req: any, res: any) => {
    const r = await profileApi.reset();
    res.status(r.status).json(r.body);
  });

  console.log(`  [webview] control panel mounted at ${MOUNT} (${opts.password ? 'password protected' : 'off for browsers until ADMIN_PASSWORD is set'})`);

  return {
    emit,
    stage,
    update: (partial) => {
      if (partial.onSay) onSay = partial.onSay;
      if (partial.source) source = partial.source;
      if (partial.onSetActive) onSetActive = partial.onSetActive;
      if (partial.onSetMode) onSetMode = partial.onSetMode;
      if (partial.onOnboarding) onOnboarding = partial.onOnboarding;
      if (typeof partial.active === 'boolean') active = partial.active;
    },
  };
}
