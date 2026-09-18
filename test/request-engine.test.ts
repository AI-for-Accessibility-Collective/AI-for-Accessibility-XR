// request-engine.test.ts — conversation history, without calling the API: a
// stepwise walkthrough only advances if each turn carries the ones before it.

import { beforeEach, describe, expect, test } from 'bun:test';
import { createConversation } from '../src/engine/request-engine.ts';
import { resetGeminiGuard, resetThinkingCache } from '../src/engine/gemini-rest.ts';

function recorder(replies: Array<string | { status: number }>) {
  const bodies: any[] = [];
  let i = 0;
  const f = (async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body));
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    if (typeof reply !== 'string') return new Response('upstream error', { status: reply.status });
    const candidate = reply
      ? { content: { parts: [{ text: reply }] }, finishReason: 'STOP' }
      : { finishReason: 'SAFETY' };
    return new Response(JSON.stringify({ candidates: [candidate] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, bodies };
}

const base = { apiKey: 'k', model: 'history-model', systemInstruction: 'SI', temperature: 0.2 };
const user = (text: string) => ({ role: 'user', parts: [{ text }] });
const model = (text: string) => ({ role: 'model', parts: [{ text }] });

beforeEach(() => {
  resetThinkingCache();
  resetGeminiGuard();
});

describe('createConversation', () => {
  test('the second turn carries the first exchange', async () => {
    const { f, bodies } = recorder(['Open the drawer.', 'Turn the dial.']);
    const c = createConversation(base, f);
    expect(await c.turn('help me')).toBe('Open the drawer.');
    expect(await c.turn('done')).toBe('Turn the dial.');
    expect(bodies[0].contents).toEqual([user('help me')]);
    expect(bodies[1].contents).toEqual([user('help me'), model('Open the drawer.'), user('done')]);
  });

  test('camera frames go only on the current turn, never into history', async () => {
    const { f, bodies } = recorder(['I see a dial.', 'Next.']);
    const c = createConversation(base, f);
    await c.turn('what is this?', [{ jpeg: Buffer.from('frame-bytes'), timestamp: 0 }]);
    await c.turn('done');
    expect(bodies[0].contents[0].parts[0].inlineData.mimeType).toBe('image/jpeg');
    expect(bodies[1].contents[0]).toEqual(user('what is this?'));
  });

  test('an empty reply is left out of history, so the next turn is still valid', async () => {
    const { f, bodies } = recorder(['', 'Turn the dial.']);
    const c = createConversation(base, f);
    expect(await c.turn('first')).toBe('');
    await c.turn('again');
    expect(bodies[1].contents).toEqual([user('again')]);
    expect(bodies[1].contents.every((m: any) => m.parts.every((p: any) => p.text !== ''))).toBe(true);
  });

  test('history is trimmed to maxHistoryTurns', async () => {
    const { f, bodies } = recorder(['1.', '2.', '3.']);
    const c = createConversation({ ...base, maxHistoryTurns: 1 }, f);
    await c.turn('a');
    await c.turn('b');
    await c.turn('c');
    expect(bodies[2].contents).toEqual([user('b'), model('2.'), user('c')]);
  });

  test('a failed turn rejects that turn only; the next one still runs', async () => {
    const { f, bodies } = recorder([{ status: 503 }, 'Back again.']);
    const c = createConversation(base, f);
    await expect(c.turn('a')).rejects.toThrow(/HTTP 503/);
    expect(await c.turn('b')).toBe('Back again.');
    expect(bodies[1].contents).toEqual([user('b')]);
  });
});
