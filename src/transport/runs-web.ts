// The "Past runs" pages, mounted next to the control panel at /webview/runs.
//
// A run holds camera images from inside someone's home, so every route here —
// pages, JSON, frames, clips, delete — sits behind the shared guard
// (admin-auth.ts): ADMIN_PASSWORD over HTTP Basic auth. With no password set,
// every route answers 404, as if the feature did not exist; takes are still
// recorded to disk either way.
//
// One self-contained page (runs.html) draws the list, a run and the A/B
// comparison; which one it shows comes from its own URL.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExpressLike } from './webview.ts';
import { createGuard, type Handler } from './admin-auth.ts';
import { isRunId, type RunRecorder } from '../runtime/run-recorder.ts';

const MOUNT = '/webview/runs';

export interface RunsWebOptions {
  app: ExpressLike;
  recorder: RunRecorder;
  password: string;
}

export function mountRuns(opts: RunsWebOptions): void {
  const { app, recorder, password } = opts;
  const html = readFileSync(fileURLToPath(new URL('./runs.html', import.meta.url)), 'utf8');

  if (!password) {
    console.log(`  [runs] run history pages are off until ADMIN_PASSWORD is set (takes are still recorded)`);
  } else {
    console.log(`  [runs] run history mounted at ${MOUNT} (password protected)`);
  }

  const guarded = createGuard({ password, tag: 'runs' });

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
