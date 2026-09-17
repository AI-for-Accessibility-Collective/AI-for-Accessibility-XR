// A simple, screen-shareable browser view of what the wearable is doing —
// the load-bearing demo surface (docs/PLAN.md ground rule 3).
//
// One standalone Bun.serve on its own port (config.demoPort), started
// identically whether we're driving from glasses (index.ts) or the
// hardware-free harness (src/scripts/drive-core.ts). It renders the shared
// FrameStore as a live MJPEG feed and streams session events (what the user
// asked, what the guide replied, status) over SSE.
//
// Trimmed on copy from the old draft (no onboarding routes, no /gemini, no
// noise meter, no skill-gate settings) and extended for the films:
//   GET  /status    the session state (mode, granted needs, consent card, step)
//   POST /mode      the A/B toggle — {mode: 'baseline'|'toolkit'}
//   POST /consent   a consent-card tap — {response: 'accept'|'declineOnce'}
//   POST /reset     the retake button
//   POST /shutdown  the page's ■ Stop button — the host halts Gemini and exits
//
// Spending safety nets live here because only the server sees the pages: when
// the last demo page has been closed for a few seconds (after at least one
// page connected, so a headless check run never trips it), or nobody has
// clicked or typed for a long stretch, the host is told to pause Gemini. A
// spoken utterance that repeats the guide's own recent words is dropped as
// mic echo, so the guide can never keep a conversation going with itself.
//
// No Mentra dependency and no new npm deps — just Bun's built-in HTTP server.

import type { FrameStore } from './frames.ts';
import type { SessionEvent, SessionState, GuideMode } from '../runtime/session.ts';

export type DemoEvent = SessionEvent;
export type DemoSource = 'file' | 'webcam' | 'glasses' | 'rtmp' | 'none';
export type SourceKind = 'file' | 'webcam' | 'rtmp';

export interface SourceClip {
  id: string;
  name: string;
}
export interface SourceCatalog {
  clips: SourceClip[];
  webcam: boolean;
  rtmp: boolean;
}
export interface SourceSelection {
  kind: SourceKind | 'none';
  clipId?: string;
}

export interface DemoServerOptions {
  port: number;
  frames: FrameStore;
  source: DemoSource;
  // An utterance from the browser (typed or browser-STT) — stands in for the mic.
  onSay: (text: string, opts?: { typed?: boolean }) => void;
  // The session's live state, rendered into /status for the panels.
  sessionState: () => SessionState;
  // The A/B toggle.
  onSetMode?: (mode: GuideMode) => void | Promise<void>;
  // A consent-card tap.
  onConsent?: (response: 'accept' | 'declineOnce') => void | Promise<void>;
  // Pause/resume all Gemini activity (the page's Start switch).
  onSetActive?: (active: boolean) => void;
  // Synthesize speech for the demo speaker (Gemini TTS, style line applied by
  // the caller from the live render). No-op if absent.
  tts?: (text: string) => Promise<{ audio: Uint8Array; mime: string } | null>;
  // When true, the browser may push its own webcam frames via POST /frame.
  acceptBrowserCam?: boolean;
  sourceCatalog?: SourceCatalog;
  currentClipId?: string;
  onSetSource?: (sel: SourceSelection) => void | Promise<void>;
  streamFps?: number;
  // The retake button: wipe the app store and re-import the fixture profile.
  onReset?: () => Promise<void> | void;
  // The page's ■ Stop button. The host halts Gemini and exits the process.
  onShutdown?: () => void;
  // Every demo page has been closed for pagesClosedGraceMs.
  onPagesClosed?: () => void;
  pagesClosedGraceMs?: number;
  // Gemini was on and nobody clicked, tapped or typed for idleMs.
  onIdle?: () => void;
  idleMs?: number;
}

export interface DemoServerHandle {
  stop: () => void;
  emit: (e: DemoEvent) => void;
  update: (
    partial: Partial<Pick<DemoServerOptions, 'onSay' | 'source' | 'currentClipId' | 'onSetActive' | 'onSetMode' | 'onConsent'>> & {
      // Backend-initiated switch state (a safety net or the guard paused Gemini).
      active?: boolean;
    },
  ) => void;
}

const HTML_PATH = new URL('./demo.html', import.meta.url);

const ECHO_WINDOW_MS = 120_000;
const MIN_ECHO_WORDS = 4;

function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function startDemoServer(opts: DemoServerOptions): DemoServerHandle {
  const streamFps = Math.max(1, opts.streamFps ?? 8);
  const frameIntervalMs = Math.max(50, Math.round(1000 / streamFps));

  // Live, updatable context (index.ts repoints these per glasses session).
  let onSay = opts.onSay;
  let source = opts.source;
  let onSetActive = opts.onSetActive;
  let onSetMode = opts.onSetMode;
  let onConsent = opts.onConsent;
  const onSetSource = opts.onSetSource;
  let currentClipId = opts.currentClipId;
  let active = false; // start STOPPED; the page's Start switch resumes

  // SSE fan-out + a small ring so a freshly-opened page gets recent context.
  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const recent: DemoEvent[] = [];
  const enc = new TextEncoder();

  // Safety-net state.
  let lastHumanAt = Date.now();
  const humanActed = () => {
    lastHumanAt = Date.now();
  };
  let pagesSeen = false;
  let pagesClosedTimer: ReturnType<typeof setTimeout> | null = null;
  const recentSpeech: Array<{ text: string; at: number }> = [];

  function sseChunk(e: DemoEvent): Uint8Array {
    return enc.encode(`data: ${JSON.stringify(e)}\n\n`);
  }

  function dropClient(c: ReadableStreamDefaultController<Uint8Array>): void {
    if (!sseClients.delete(c)) return;
    if (sseClients.size > 0 || !pagesSeen || !opts.onPagesClosed || pagesClosedTimer) return;
    pagesClosedTimer = setTimeout(() => {
      pagesClosedTimer = null;
      if (sseClients.size === 0 && active) {
        active = false;
        opts.onPagesClosed!();
      }
    }, opts.pagesClosedGraceMs ?? 10_000);
  }

  function emit(e: DemoEvent): void {
    recent.push(e);
    if (recent.length > 50) recent.shift();
    if (e.type === 'assistant') {
      recentSpeech.push({ text: normalizeSpeech(e.text), at: e.ts });
      while (recentSpeech.length > 20 || (recentSpeech[0] && e.ts - recentSpeech[0].at > ECHO_WINDOW_MS)) recentSpeech.shift();
    }
    const chunk = sseChunk(e);
    for (const c of [...sseClients]) {
      try {
        c.enqueue(chunk);
      } catch {
        dropClient(c);
      }
    }
  }

  // True when a spoken utterance is the guide's own recent words coming back
  // through the mic.
  function soundsLikeTheGuide(utterance: string): boolean {
    const u = normalizeSpeech(utterance);
    if (u.split(' ').length < MIN_ECHO_WORDS) return false;
    const now = Date.now();
    return recentSpeech.some((s) => now - s.at < ECHO_WINDOW_MS && s.text.includes(u));
  }

  // Keep SSE connections alive through idle stretches (no events for a while).
  const heartbeat = setInterval(() => {
    const ping = enc.encode(': ping\n\n');
    for (const c of [...sseClients]) {
      try {
        c.enqueue(ping);
      } catch {
        dropClient(c);
      }
    }
  }, 20000);

  const idleTimer =
    opts.onIdle && opts.idleMs
      ? setInterval(() => {
          if (active && Date.now() - lastHumanAt > opts.idleMs!) {
            active = false;
            opts.onIdle!();
          }
        }, 15_000)
      : null;

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const server = Bun.serve({
    port: opts.port,
    idleTimeout: 255, // long-lived MJPEG/SSE streams must not be reaped
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === '/favicon.ico') return new Response(null, { status: 204 });

      if (path === '/' || path === '/index.html') {
        return new Response(Bun.file(HTML_PATH), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // Live MJPEG feed of the shared FrameStore. A plain <img src> renders it.
      if (path === '/stream.mjpg') {
        const boundary = 'wearableframe';
        let timer: ReturnType<typeof setInterval> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(() => {
              if (source === 'none') return;
              const jpeg = opts.frames.latest();
              if (!jpeg) return;
              try {
                controller.enqueue(
                  enc.encode(
                    `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
                  ),
                );
                controller.enqueue(new Uint8Array(jpeg));
                controller.enqueue(enc.encode('\r\n'));
              } catch {
                if (timer) clearInterval(timer);
              }
            }, frameIntervalMs);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        });
        return new Response(stream, {
          headers: {
            'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
            'Cache-Control': 'no-store',
            Connection: 'close',
          },
        });
      }

      // Single latest frame — polling fallback + browser-cam round-trip preview.
      if (path === '/frame.jpg') {
        if (source === 'none') return new Response('no source', { status: 404 });
        const jpeg = opts.frames.latest();
        if (!jpeg) return new Response('No frame yet', { status: 404 });
        return new Response(new Uint8Array(jpeg), {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
        });
      }

      // Session events as Server-Sent Events. Each connected stream is one
      // open demo page — the pages-closed safety net counts these.
      if (path === '/events') {
        let self: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            sseClients.add(controller);
            pagesSeen = true;
            if (pagesClosedTimer) {
              clearTimeout(pagesClosedTimer);
              pagesClosedTimer = null;
            }
            for (const e of recent) controller.enqueue(sseChunk(e));
            controller.enqueue(
              sseChunk({
                type: 'status',
                text: `Connected · source: ${source} · ${opts.sessionState().mode} mode`,
                ts: Date.now(),
              }),
            );
          },
          cancel() {
            if (self) dropClient(self);
          },
        });
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          },
        });
      }

      // Status: source/feed state + the full session state for the rail.
      if (path === '/status') {
        return jsonResponse({
          source,
          frames: opts.frames.size,
          acceptBrowserCam: !!opts.acceptBrowserCam,
          sourceCatalog: opts.sourceCatalog ?? null,
          canSetSource: !!onSetSource,
          currentClipId,
          active,
          canSetMode: !!onSetMode,
          canReset: !!opts.onReset,
          canShutdown: !!opts.onShutdown,
          state: opts.sessionState(),
        });
      }

      // The page's ■ Stop button. Answer first, then let the host shut down.
      if (path === '/shutdown' && req.method === 'POST') {
        if (!opts.onShutdown) return new Response('shutdown not available here', { status: 409 });
        active = false;
        setTimeout(() => opts.onShutdown!(), 50);
        return jsonResponse({ stopping: true }, 202);
      }

      // The A/B toggle: baseline ↔ toolkit. Live — the session re-renders.
      if (path === '/mode' && req.method === 'POST') {
        if (!onSetMode) return new Response('mode not settable', { status: 409 });
        humanActed();
        try {
          const body = (await req.json()) as { mode?: unknown };
          if (body.mode !== 'baseline' && body.mode !== 'toolkit') {
            return new Response('bad mode', { status: 400 });
          }
          await onSetMode(body.mode);
        } catch {
          return new Response('Bad JSON', { status: 400 });
        }
        return new Response(null, { status: 204 });
      }

      // A consent-card tap from the panel.
      if (path === '/consent' && req.method === 'POST') {
        if (!onConsent) return new Response('consent not wired', { status: 409 });
        humanActed();
        try {
          const body = (await req.json()) as { response?: unknown };
          if (body.response !== 'accept' && body.response !== 'declineOnce') {
            return new Response('bad response', { status: 400 });
          }
          await onConsent(body.response);
        } catch {
          return new Response('Bad JSON', { status: 400 });
        }
        return new Response(null, { status: 204 });
      }

      // The retake button: wipe the app store, re-import the fixture profile.
      if (path === '/reset' && req.method === 'POST') {
        if (!opts.onReset) return new Response('reset not available', { status: 409 });
        humanActed();
        await opts.onReset();
        return new Response(null, { status: 204 });
      }

      // Typed/spoken utterance from the browser (stands in for the mic).
      if (path === '/say' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { text?: unknown; typed?: unknown };
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (text) {
            if (body.typed) {
              humanActed();
            } else if (soundsLikeTheGuide(text)) {
              emit({ type: 'status', ts: Date.now(), text: `Ignored "${text.slice(0, 60)}" — the mic heard the guide's own words` });
              return new Response(null, { status: 204 });
            }
            onSay(text, { typed: !!body.typed });
          }
        } catch {
          return new Response('Bad JSON', { status: 400 });
        }
        return new Response(null, { status: 204 });
      }

      // Pause/resume the backend's Gemini activity.
      if (path === '/active' && req.method === 'POST') {
        humanActed();
        try {
          const body = (await req.json()) as { active?: unknown };
          active = !!body.active;
          onSetActive?.(active);
        } catch {
          return new Response('Bad JSON', { status: 400 });
        }
        return new Response(null, { status: 204 });
      }

      // Switch the live video source (clip / webcam / smartglass stream).
      // Switching PAUSES Gemini (active → false) so nothing bills mid-switch.
      if (path === '/source' && req.method === 'POST') {
        if (!onSetSource) return new Response('source not settable', { status: 409 });
        humanActed();
        let sel: SourceSelection;
        try {
          const body = (await req.json()) as { kind?: unknown; clipId?: unknown };
          if (body.kind !== 'file' && body.kind !== 'webcam' && body.kind !== 'rtmp' && body.kind !== 'none') {
            return new Response('bad source kind', { status: 400 });
          }
          sel = { kind: body.kind, clipId: typeof body.clipId === 'string' ? body.clipId : undefined };
        } catch {
          return new Response('Bad JSON', { status: 400 });
        }
        active = false;
        source = sel.kind;
        currentClipId = sel.kind === 'file' ? sel.clipId : undefined;
        try {
          await onSetSource(sel);
        } catch (e) {
          return new Response(e instanceof Error ? e.message : 'source switch failed', { status: 500 });
        }
        return new Response(null, { status: 204 });
      }

      // Speak a line through the demo speaker using Gemini TTS.
      if (path === '/tts') {
        if (!opts.tts) return new Response('tts disabled', { status: 409 });
        const text = (url.searchParams.get('text') || '').trim();
        if (!text) return new Response('no text', { status: 400 });
        const out = await opts.tts(text);
        if (!out) return new Response('tts failed', { status: 502 });
        return new Response(out.audio, {
          headers: { 'Content-Type': out.mime, 'Cache-Control': 'no-store' },
        });
      }

      // Browser webcam frame -> shared FrameStore. Gated: only when browser-cam
      // is enabled AND the webcam is the current source.
      if (path === '/frame' && req.method === 'POST') {
        if (!opts.acceptBrowserCam) return new Response('browser-cam disabled', { status: 409 });
        if (onSetSource && source !== 'webcam') return new Response('not in webcam mode', { status: 409 });
        const buf = Buffer.from(await req.arrayBuffer());
        if (buf.length > 1000) opts.frames.push(buf);
        return new Response(null, { status: 204 });
      }

      return new Response('Not found', { status: 404 });
    },
  });

  console.log(`  [demo] browser view on http://localhost:${opts.port} (source=${source})`);

  return {
    stop: () => {
      clearInterval(heartbeat);
      if (idleTimer) clearInterval(idleTimer);
      if (pagesClosedTimer) clearTimeout(pagesClosedTimer);
      for (const c of [...sseClients]) {
        try {
          c.close();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      server.stop(true);
    },
    emit,
    update: (partial) => {
      if (partial.onSay) onSay = partial.onSay;
      if (partial.source) source = partial.source;
      if (partial.currentClipId !== undefined) currentClipId = partial.currentClipId;
      if (partial.onSetActive) onSetActive = partial.onSetActive;
      if (partial.onSetMode) onSetMode = partial.onSetMode;
      if (partial.onConsent) onConsent = partial.onConsent;
      if (typeof partial.active === 'boolean') active = partial.active;
    },
  };
}
