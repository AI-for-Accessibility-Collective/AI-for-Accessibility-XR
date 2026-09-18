// The "Past runs" pages, mounted next to the control panel at /webview/runs.
//
// Unlike the rest of /webview these are NOT public: a run holds camera images
// from inside someone's home. Every route here — pages, JSON, frames, clips,
// delete — asks for ADMIN_PASSWORD over HTTP Basic auth (any user name). With
// no password set, every route answers 404, as if the feature did not exist;
// takes are still recorded to disk either way.
//
// One self-contained page (runs.html) draws the list, a run and the A/B
// comparison; which one it shows comes from its own URL.

import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ExpressLike } from './webview.ts';
import { isRunId, type RunRecorder } from '../runtime/run-recorder.ts';

const MOUNT = '/webview/runs';

// Guessing a password over HTTP is slow but free; past this many wrong tries
// in a minute everyone waits the minute out.
const MAX_FAILURES_PER_MINUTE = 20;

export interface RunsWebOptions {
  app: ExpressLike;
  recorder: RunRecorder;
  password: string;
}

function passwordMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// "Basic base64(user:password)" → the password, or null.
function basicPassword(header: unknown): string | null {
  if (typeof header !== 'string' || !/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

export function mountRuns(opts: RunsWebOptions): void {
  const { app, recorder, password } = opts;
  const html = readFileSync(fileURLToPath(new URL('./runs.html', import.meta.url)), 'utf8');

  if (!password) {
    console.log(`  [runs] run history pages are off until ADMIN_PASSWORD is set (takes are still recorded)`);
  } else {
    console.log(`  [runs] run history mounted at ${MOUNT} (password protected)`);
  }

  let failures = 0;
  let windowStart = Date.now();

  type Handler = (req: any, res: any) => void;
  const guarded =
    (handler: Handler): Handler =>
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex');
      if (!password) return void res.status(404).send('Not found');
      if (Date.now() - windowStart > 60_000) {
        windowStart = Date.now();
        failures = 0;
      }
      if (failures >= MAX_FAILURES_PER_MINUTE) return void res.status(429).send('Too many wrong passwords — wait a minute');
      const given = basicPassword(req.headers?.authorization);
      if (given == null || !passwordMatches(given, password)) {
        if (given != null) failures++;
        res.setHeader('WWW-Authenticate', 'Basic realm="Wearable Task Guide past runs", charset="UTF-8"');
        return void res.status(401).send('Password required');
      }
      try {
        handler(req, res);
      } catch (e) {
        console.error('[runs] request failed:', e instanceof Error ? e.message : e);
        if (!res.headersSent) res.status(500).send('Something went wrong');
      }
    };

  const page: Handler = (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.send(html);
  };

  // ---- pages (one file; the URL picks the view) ----
  app.get([MOUNT, `${MOUNT}/`, `${MOUNT}/compare`], guarded(page));

  // ---- JSON ----
  app.get(`${MOUNT}/api/list`, guarded((_req, res) => {
    res.json({ runs: recorder.listRuns(), liveId: recorder.current()?.id ?? null });
  }));

  app.get(`${MOUNT}/api/:id`, guarded((req, res) => {
    const id = String(req.params.id);
    const found = isRunId(id) ? recorder.readRun(id) : null;
    if (!found) return void res.status(404).json({ error: 'No such run' });
    if (req.query?.download != null) res.setHeader('Content-Disposition', `attachment; filename="run-${id}.json"`);
    res.json(found);
  }));

  // A form on another site can POST here with the browser's saved password,
  // but it cannot add a custom header — so the page must send one.
  app.post(`${MOUNT}/api/:id/delete`, guarded((req, res) => {
    if (req.headers?.['x-runs-action'] !== 'delete') return void res.status(400).json({ error: 'Bad request' });
    const id = String(req.params.id);
    const outcome = isRunId(id) ? recorder.deleteRun(id) : 'missing';
    if (outcome === 'live') return void res.status(409).json({ error: 'This run is still going — stop it first' });
    if (outcome === 'missing') return void res.status(404).json({ error: 'No such run' });
    res.json({ deleted: id });
  }));

  // ---- media ----
  const media = (kind: 'frames' | 'audio', type: string): Handler =>
    guarded((req, res) => {
      const id = String(req.params.id);
      const file = String(req.params.file);
      const full = kind === 'frames' ? recorder.framePath(id, file) : recorder.audioPath(id, file);
      if (!full) return void res.status(404).send('Not found');
      res.setHeader('Content-Type', type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // sendFile answers byte-range requests, which Safari insists on before
      // it plays a clip. The path is already vetted, so dot folders in
      // RUNS_DIR are fine.
      res.sendFile(full, { cacheControl: false, etag: false, lastModified: false, dotfiles: 'allow' }, (err: unknown) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    });
  app.get(`${MOUNT}/:id/frames/:file`, media('frames', 'image/jpeg'));
  app.get(`${MOUNT}/:id/audio/:file`, media('audio', 'audio/wav'));

  // ---- one run (after the fixed names above, so "compare" never lands here) ----
  app.get(`${MOUNT}/:id`, guarded((req, res) => {
    const id = String(req.params.id);
    if (!isRunId(id)) return void res.status(404).send('Not found');
    // A run that is gone still gets the page, which explains and links back.
    if (!recorder.readRun(id)) res.status(404);
    page(req, res);
  }));
}
