// gemini-rest.test.ts — the thinking ladder against a fake fetch (models that
// accept thinkingBudget:0, models that reject it, thinking-only models,
// per-model memory, errors that must NOT trigger it), plus the key-handling
// and failure-shape guarantees: key in a header, never in a thrown error;
// stalled requests time out; blocked prompts say so.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  abortInFlightGemini,
  configureGeminiGuard,
  geminiHaltReason,
  generateContent,
  haltGemini,
  resetGeminiGuard,
  resetThinkingCache,
} from '../src/engine/gemini-rest.ts';
import { synthesizeSpeech } from '../src/engine/tts.ts';

beforeEach(() => resetGeminiGuard());

// A fake Gemini that never answers, but rejects the way fetch does once the
// request's signal is aborted.
function hangingFetch() {
  let calls = 0;
  const f = (async (_url: unknown, init: any) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  }) as unknown as typeof fetch;
  return { f, calls: () => calls };
}

describe('the stop switch and the runaway guard', () => {
  const reply = () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }), { status: 200 });
  const request = (model: string) => ({
    apiKey: 'test-key-123',
    model,
    contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
    maxOutputTokens: 1024,
    temperature: 0.2,
  });

  test('after haltGemini no request goes out, and the error says why', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return reply();
    }) as unknown as typeof fetch;
    haltGemini('Stop button');
    await expect(generateContent(request('halt-a'), f)).rejects.toThrow('Gemini is stopped (Stop button)');
    expect(calls).toBe(0);
    expect(geminiHaltReason()).toBe('Stop button');
  });

  test('halting cancels a request already in flight', async () => {
    const { f } = hangingFetch();
    const pending = generateContent(request('halt-b'), f);
    await Bun.sleep(5);
    haltGemini('Ctrl-C');
    await expect(pending).rejects.toThrow('gemini halt-b stopped: Ctrl-C');
  });

  test('a pause cancels what is in flight but does not block later requests', async () => {
    const { f: hanging } = hangingFetch();
    const pending = generateContent(request('pause-a'), hanging);
    await Bun.sleep(5);
    abortInFlightGemini('paused');
    await expect(pending).rejects.toThrow('gemini pause-a stopped: paused');
    const f = (async () => reply()) as unknown as typeof fetch;
    await expect(generateContent(request('pause-a'), f)).resolves.toMatchObject({ text: 'ok' });
    expect(geminiHaltReason()).toBeNull();
  });

  test('requests piling up within a minute turn Gemini off once, and tell the host', async () => {
    const halts: string[] = [];
    configureGeminiGuard({ maxPerMinute: 3, onHalt: (r) => void halts.push(r) });
    let calls = 0;
    const f = (async () => {
      calls++;
      return reply();
    }) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) await generateContent(request('loop-a'), f);
    await expect(generateContent(request('loop-a'), f)).rejects.toThrow(/3 Gemini requests in the last minute reached the limit of 3/);
    await expect(generateContent(request('loop-a'), f)).rejects.toThrow(/Gemini is stopped/);
    expect(calls).toBe(3);
    expect(halts).toHaveLength(1);
  });

  test('the per-run limit turns Gemini off too', async () => {
    configureGeminiGuard({ maxPerMinute: 100, maxPerRun: 2 });
    const f = (async () => reply()) as unknown as typeof fetch;
    await generateContent(request('run-a'), f);
    await generateContent(request('run-a'), f);
    await expect(generateContent(request('run-a'), f)).rejects.toThrow(/2 Gemini requests this run reached the limit of 2/);
  });

  test('text-to-speech goes through the same switch: nothing is requested once stopped', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return reply();
    }) as unknown as typeof fetch;
    try {
      haltGemini('Stop button');
      const out = await synthesizeSpeech({ apiKey: 'test-key-123', model: 'tts-model', voice: 'Kore', text: 'hello' });
      expect(out).toBeNull();
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

type Reply = { status: number; json?: unknown; text?: string };

function fakeFetch(handler: (body: any, url: string, init: any) => Reply | Promise<Reply>) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const f = (async (url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    const r = await handler(body, String(url), init);
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const ok = (text: string | string[], thoughts = 0): Reply => ({
  status: 200,
  json: {
    candidates: [
      {
        content: { parts: (Array.isArray(text) ? text : [text]).map((t) => ({ text: t, thoughtSignature: 'sig' })) },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { thoughtsTokenCount: thoughts },
  },
});

const KEY = 'test-key-123';
const opts = (model: string, extra: Record<string, unknown> = {}) => ({
  apiKey: KEY,
  model,
  contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
  maxOutputTokens: 1024,
  temperature: 0.2,
  ...extra,
});

const thinkingOf = (body: any) => body.generationConfig.thinkingConfig;

beforeEach(() => resetThinkingCache());

describe('model that accepts thinkingBudget:0', () => {
  test('one request, budget 0 sent, parts joined, thoughts parsed', async () => {
    const { f, calls } = fakeFetch(() => ok(['Open the ', 'drawer.'], 12));
    const r = await generateContent(opts('flash-a'), f);
    expect(calls).toHaveLength(1);
    expect(thinkingOf(calls[0]!.body)).toEqual({ thinkingBudget: 0 });
    expect(calls[0]!.body.generationConfig.maxOutputTokens).toBe(1024);
    expect(r).toEqual({ text: 'Open the drawer.', finishReason: 'STOP', thoughtTokens: 12, thinking: 'budget0' });
  });
});

describe('model that rejects budget 0 but takes thinkingLevel low', () => {
  const handler = (body: any): Reply =>
    thinkingOf(body)?.thinkingBudget === 0 ? { status: 400, text: 'Request contains an invalid argument.' } : ok('ok');

  test('steps down once, then remembers the rung for later turns', async () => {
    const { f, calls } = fakeFetch(handler);
    const first = await generateContent(opts('flash-b'), f);
    expect(first.thinking).toBe('level-low');
    expect(calls).toHaveLength(2);
    expect(thinkingOf(calls[1]!.body)).toEqual({ thinkingLevel: 'low' });

    await generateContent(opts('flash-b'), f);
    expect(calls).toHaveLength(3); // no second rejection
    expect(thinkingOf(calls[2]!.body)).toEqual({ thinkingLevel: 'low' });
  });
});

describe('thinking-only model (pro)', () => {
  test('falls to the model default with no thinkingConfig and a raised output cap', async () => {
    const { f, calls } = fakeFetch((body) =>
      thinkingOf(body) ? { status: 400, text: 'Budget 0 is invalid. This model only works in thinking mode.' } : ok('ok', 900),
    );
    const r = await generateContent(opts('pro-a'), f);
    expect(r.thinking).toBe('model-default');
    expect(calls).toHaveLength(3);
    expect(thinkingOf(calls[2]!.body)).toBeUndefined();
    expect(calls[2]!.body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(8192);
  });
});

describe('errors that are not about thinking', () => {
  test('a 400 on every rung throws, names the first rejection, and caches nothing', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 400, text: 'Unable to process input image.' }));
    await expect(generateContent(opts('flash-c'), f)).rejects.toThrow(/HTTP 400.*first rejection: Unable to process input image/);
    expect(calls).toHaveLength(3);
    // Next request starts from the top again — a bad request didn't demote the model.
    await expect(generateContent(opts('flash-c'), f)).rejects.toThrow();
    expect(thinkingOf(calls[3]!.body)).toEqual({ thinkingBudget: 0 });
  });

  test('a 500 throws immediately without stepping down', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 500, text: 'internal' }));
    await expect(generateContent(opts('flash-d'), f)).rejects.toThrow(/HTTP 500: internal/);
    expect(calls).toHaveLength(1);
  });

  test('a 429 throws immediately (rate limit is not a thinking rejection)', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 429, text: 'quota' }));
    await expect(generateContent(opts('flash-e'), f)).rejects.toThrow(/HTTP 429/);
    expect(calls).toHaveLength(1);
  });
});

describe('the API key', () => {
  test('travels in the x-goog-api-key header, never in the URL', async () => {
    const { f, calls } = fakeFetch(() => ok('ok'));
    await generateContent(opts('flash-k'), f);
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0]!.url).not.toContain(KEY);
    expect(calls[0]!.url).not.toContain('key=');
  });

  test('a network error is re-thrown as a plain message, without the request attached', async () => {
    const netError = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
      code: 'ConnectionRefused',
      path: `https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=${KEY}`,
    });
    const { f } = fakeFetch(() => {
      throw netError;
    });
    const err = await generateContent(opts('flash-n'), f).then(
      () => null,
      (e: unknown) => e as Error & { path?: string },
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/gemini flash-n request failed: Unable to connect/);
    expect(err!.path).toBeUndefined();
    expect(JSON.stringify({ ...err, message: err!.message })).not.toContain(KEY);
  });

  test('an error body that echoes the key is redacted', async () => {
    const { f } = fakeFetch(() => ({ status: 403, text: `API key ${KEY} is not valid for this project` }));
    const err = await generateContent(opts('flash-r'), f).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err!.message).toContain('[key]');
    expect(err!.message).not.toContain(KEY);
  });
});

describe('failure shapes', () => {
  test('a stalled request times out with a plain error', async () => {
    const { f } = fakeFetch(
      (_body, _url, init) =>
        new Promise<Reply>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );
    await expect(generateContent(opts('flash-t', { timeoutMs: 30 }), f)).rejects.toThrow('gemini flash-t timed out after 30 ms');
  });

  test('a blocked prompt reports its block reason instead of UNKNOWN', async () => {
    const { f } = fakeFetch(() => ({ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } }));
    const r = await generateContent(opts('flash-s'), f);
    expect(r.text).toBe('');
    expect(r.finishReason).toBe('BLOCKED_SAFETY');
  });
});

describe('guarantees that must not silently regress', () => {
  test('every request carries a deadline even when the caller sets none', async () => {
    let signal: AbortSignal | undefined;
    const { f } = fakeFetch((_body, _url, init) => {
      signal = init.signal;
      return ok('ok');
    });
    await generateContent(opts('flash-dl'), f);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  test('a network error whose message echoes the key is redacted', async () => {
    const { f } = fakeFetch(() => {
      throw new Error(`connect ECONNREFUSED for https://example.invalid/?key=${KEY}`);
    });
    const err = await generateContent(opts('flash-nm'), f).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err!.message).toContain('[key]');
    expect(err!.message).not.toContain(KEY);
  });

  test('a 200 whose body is not JSON is a plain, wrapped error', async () => {
    const { f } = fakeFetch(() => ({ status: 200, text: '<html>captive portal</html>' }));
    await expect(generateContent(opts('flash-html'), f)).rejects.toThrow(/gemini flash-html unreadable response/);
  });
});

describe('request shape', () => {
  test('rung memory is per model', async () => {
    const { f, calls } = fakeFetch((body, url) =>
      url.includes('/pro-b:') && thinkingOf(body) ? { status: 400, text: 'thinking mode only' } : ok('ok'),
    );
    await generateContent(opts('pro-b'), f);
    await generateContent(opts('flash-f'), f);
    const flashCall = calls.find((c) => c.url.includes('/flash-f:'))!;
    expect(thinkingOf(flashCall.body)).toEqual({ thinkingBudget: 0 });
  });

  test('systemInstruction sent only when present; empty candidate yields empty text', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, json: { candidates: [{ finishReason: 'MAX_TOKENS' }] } }));
    const r = await generateContent(opts('flash-g'), f);
    expect(calls[0]!.body.systemInstruction).toBeUndefined();
    expect(r.text).toBe('');
    expect(r.finishReason).toBe('MAX_TOKENS');

    await generateContent(opts('flash-g', { systemInstruction: 'Be brief.' }), f);
    expect(calls[1]!.body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
  });
});
