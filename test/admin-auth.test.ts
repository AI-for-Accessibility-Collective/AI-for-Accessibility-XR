// admin-auth.test.ts — the lock on the public pages: a browser's password, the
// phone's bearer token, 404 while no password is set, and the wrong-try limit.

import { describe, expect, test } from 'bun:test';
import { basicPassword, bearerToken, createGuard } from '../src/transport/admin-auth.ts';

function call(guard: ReturnType<typeof createGuard>, authorization?: string) {
  let status = 200;
  let body = '';
  const headers: Record<string, string> = {};
  let ran = false;
  const res = {
    headersSent: false,
    setHeader: (k: string, v: string) => void (headers[k] = v),
    status: (s: number) => ((status = s), res),
    send: (b: string) => void (body = b),
  };
  guard((_req, r) => {
    ran = true;
    r.send('hello');
  })({ headers: authorization ? { authorization } : {} }, res);
  return { status, body, headers, ran };
}

const basic = (pw: string, user = 'anyone') => 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');

describe('header parsing', () => {
  test('basic auth yields the password, whatever the user name', () => {
    expect(basicPassword(basic('s3cret', 'x'))).toBe('s3cret');
    expect(basicPassword(basic('a:b'))).toBe('a:b');
    expect(basicPassword('Bearer t')).toBeNull();
    expect(basicPassword(undefined)).toBeNull();
  });
  test('bearer yields the token', () => {
    expect(bearerToken('Bearer tok')).toBe('tok');
    expect(bearerToken('bearer  tok ')).toBe('tok');
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken(basic('x'))).toBeNull();
  });
});

describe('createGuard', () => {
  test('the right password runs the handler', () => {
    const g = createGuard({ password: 'pw', tag: 't' });
    const r = call(g, basic('pw'));
    expect(r.ran).toBe(true);
    expect(r.body).toBe('hello');
    expect(r.headers['Cache-Control']).toBe('no-store');
  });

  test('no credentials → 401 with the browser prompt', () => {
    const r = call(createGuard({ password: 'pw', tag: 't' }));
    expect(r.ran).toBe(false);
    expect(r.status).toBe(401);
    expect(r.headers['WWW-Authenticate']).toMatch(/^Basic realm=/);
  });

  test('a wrong password → 401', () => {
    const r = call(createGuard({ password: 'pw', tag: 't' }), basic('nope'));
    expect(r.status).toBe(401);
    expect(r.ran).toBe(false);
  });

  test('the phone bridge token gets in as a bearer', () => {
    const g = createGuard({ password: 'pw', bridgeToken: 'tok', tag: 't' });
    expect(call(g, 'Bearer tok').ran).toBe(true);
    expect(call(g, 'Bearer other').status).toBe(401);
  });

  test('without a password browsers see 404, the phone still gets in', () => {
    const g = createGuard({ password: '', bridgeToken: 'tok', tag: 't' });
    expect(call(g).status).toBe(404);
    expect(call(g, basic('')).status).toBe(404);
    expect(call(g, 'Bearer tok').ran).toBe(true);
  });

  test('an empty bridge token never matches an empty bearer', () => {
    const g = createGuard({ password: '', bridgeToken: '', tag: 't' });
    expect(call(g, 'Bearer ').status).toBe(404);
  });

  test('too many wrong tries in a minute → 429, even for the right password', () => {
    const g = createGuard({ password: 'pw', tag: 't' });
    for (let i = 0; i < 20; i++) expect(call(g, basic('bad')).status).toBe(401);
    expect(call(g, basic('pw')).status).toBe(429);
  });

  test('a handler that throws answers 500', () => {
    const g = createGuard({ password: 'pw', tag: 't' });
    let status = 200;
    const res = { headersSent: false, setHeader() {}, status: (s: number) => ((status = s), res), send() {} };
    g(() => { throw new Error('boom'); })({ headers: { authorization: basic('pw') } }, res);
    expect(status).toBe(500);
  });
});
