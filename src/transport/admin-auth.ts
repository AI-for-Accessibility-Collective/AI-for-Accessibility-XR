// Who may reach the pages on the app's PUBLIC URL (/webview, /webview/runs,
// /debug/frame). They show the glasses' live camera picture, and their
// buttons drive the guide, so they are never open to whoever finds the URL.
//
// Two callers, two credentials:
//   - a person at a browser presents ADMIN_PASSWORD over HTTP Basic auth
//     (any user name); the browser asks once and remembers it;
//   - the phone app presents the BRIDGE_TOKEN it already uses on its socket,
//     as `Authorization: Bearer <token>` (fetch can set that; a browser's
//     password prompt cannot).
//
// A route wrapped by the guard answers 401 to anyone else. With no
// ADMIN_PASSWORD set, browsers get 404 instead, as if the pages did not
// exist; the phone's token still works.

import { timingSafeEqual } from 'node:crypto';

export type Handler = (req: any, res: any) => void;

export interface GuardOptions {
  // ADMIN_PASSWORD. Empty → browsers are answered 404.
  password: string;
  // BRIDGE_TOKEN. Empty → no bearer access.
  bridgeToken?: string;
  // Log prefix for a handler that throws, e.g. 'runs'.
  tag: string;
}

// The realm is shared by every guarded page, so one prompt covers them all.
export const REALM = 'Wearable Task Guide';

// Guessing a password over HTTP is slow but free; past this many wrong tries
// in a minute everyone waits the minute out.
const MAX_FAILURES_PER_MINUTE = 20;

export function secretMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// "Basic base64(user:password)" → the password, or null.
export function basicPassword(header: unknown): string | null {
  if (typeof header !== 'string' || !/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

// "Bearer <token>" → the token, or null.
export function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string' || !/^bearer /i.test(header)) return null;
  return header.slice(7).trim() || null;
}

export function createGuard(opts: GuardOptions): (handler: Handler) => Handler {
  let failures = 0;
  let windowStart = Date.now();

  return (handler) => (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');

    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      failures = 0;
    }
    if (failures >= MAX_FAILURES_PER_MINUTE) return void res.status(429).send('Too many wrong passwords — wait a minute');

    const auth = req.headers?.authorization;
    const bearer = bearerToken(auth);
    const password = basicPassword(auth);
    const ok =
      (bearer != null && secretMatches(bearer, opts.bridgeToken ?? '')) ||
      (password != null && secretMatches(password, opts.password));
    if (!ok) {
      if (bearer != null || password != null) failures++;
      if (!opts.password) return void res.status(404).send('Not found');
      res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
      return void res.status(401).send('Password required');
    }

    try {
      handler(req, res);
    } catch (e) {
      console.error(`[${opts.tag}] request failed:`, e instanceof Error ? e.message : e);
      if (!res.headersSent) res.status(500).send('Something went wrong');
    }
  };
}
