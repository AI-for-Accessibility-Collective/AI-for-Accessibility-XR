import { beforeEach, describe, expect, test } from 'bun:test';
import { ADJUST_DELIVERY_TOOL, planAdjustment } from '../src/toolkit/adjust-delivery.ts';
import { checkNeedValue } from '../src/toolkit/needs-catalog.ts';
import { createConversation } from '../src/engine/request-engine.ts';
import { resetGeminiGuard, resetThinkingCache } from '../src/engine/gemini-rest.ts';

describe('planAdjustment', () => {
  test('slower / faster move the pace one notch from where the profile is', () => {
    expect(planAdjustment({ change: 'slower' }, [])).toMatchObject({ ok: true, key: 'readAloudRate', value: 0.9 });
    expect(planAdjustment({ change: 'slower' }, [{ dimension: 'readAloudRate', value: 0.8 }])).toMatchObject({ ok: true, value: 0.7 });
    expect(planAdjustment({ change: 'faster' }, [{ dimension: 'readAloudRate', value: 0.8 }])).toMatchObject({ ok: true, value: 0.9 });
  });
  test('the pace stops at the ends of its range, and says so', () => {
    const r = planAdjustment({ change: 'slower' }, [{ dimension: 'readAloudRate', value: 0.7 }]);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/slowest/);
    expect(planAdjustment({ change: 'faster' }, [{ dimension: 'readAloudRate', value: 1.2 }]).ok).toBe(false);
  });
  test('every change the tool offers maps to a value the profile accepts', () => {
    for (const change of ADJUST_DELIVERY_TOOL.parameters.properties.change.enum) {
      const r = planAdjustment({ change }, []);
      expect(r.ok).toBe(true);
      if (r.ok) expect(checkNeedValue(r.key, r.value)).toMatchObject({ ok: true });
    }
  });
  test('changes that live in the prompt carry a standing instruction; delivery-only ones do not', () => {
    for (const change of ['one_step_at_a_time', 'everything_at_once']) {
      const r = planAdjustment({ change }, []);
      expect(r.ok && typeof r.standing === 'string' && r.standing.length > 10).toBe(true);
    }
    for (const change of ['slower', 'captions_on', 'captions_off']) {
      const r = planAdjustment({ change }, []);
      expect(r.ok && r.standing === undefined).toBe(true);
    }
  });
  test('anything else is refused without throwing', () => {
    // …including the settings the wearer is not offered anywhere else.
    for (const args of [null, {}, { change: 'louder' }, { change: 'simpler_words' }, { change: 'shorter_answers' }, { change: 5 }, 'slower']) {
      expect(planAdjustment(args, []).ok).toBe(false);
    }
  });
});

describe('the conversation engine runs a tool call and then answers in words', () => {
  beforeEach(() => {
    resetGeminiGuard();
    resetThinkingCache();
  });
  const reply = (parts: unknown[]) => new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }] }), { status: 200 });

  test('call → handler → second request carries the result and offers no tools; standing instruction persists', async () => {
    const bodies: any[] = [];
    const replies = [
      [{ functionCall: { name: 'adjust_delivery', args: { change: 'slower' } }, thoughtSignature: 'SIG123' }],
      [{ text: 'Sure, slower. Open the drawer on the top left.' }],
      [{ text: 'Now pour in the soap.' }],
    ];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return reply(replies[bodies.length - 1]!);
    }) as unknown as typeof fetch;
    const calls: Array<[string, unknown]> = [];
    const chat = createConversation(
      {
        apiKey: 'k',
        model: 'm',
        systemInstruction: 'SYS',
        tools: [ADJUST_DELIVERY_TOOL],
        onToolCall: async (name, args) => {
          calls.push([name, args]);
          return { result: 'Done: slower.', standing: 'Speak slowly from now on.' };
        },
      },
      fetchImpl,
    );

    expect(await chat.turn('that was too fast')).toBe('Sure, slower. Open the drawer on the top left.');
    expect(calls).toEqual([['adjust_delivery', { change: 'slower' }]]);
    expect(bodies[0].tools[0].functionDeclarations[0].name).toBe('adjust_delivery');
    expect(bodies[1].tools).toBeUndefined(); // the follow-up must answer in words
    const followUp = bodies[1].contents;
    expect(followUp.at(-2).parts[0].functionCall.name).toBe('adjust_delivery');
    expect(followUp.at(-2).parts[0].thoughtSignature).toBe('SIG123'); // Gemini 3 rejects the follow-up without it
    expect(followUp.at(-1).parts[0].functionResponse.response.result).toBe('Done: slower.');

    await chat.turn('done');
    expect(bodies[2].systemInstruction.parts[0].text).toContain('Speak slowly from now on.');
    // History stays text-only: the tool exchange itself is not replayed.
    expect(JSON.stringify(bodies[2].contents)).not.toContain('functionCall');
    expect(JSON.stringify(bodies[2].contents)).toContain('that was too fast');
  });

  test('a handler that throws still produces a spoken reply', async () => {
    let n = 0;
    const fetchImpl = (async () => reply(n++ === 0 ? [{ functionCall: { name: 'adjust_delivery', args: { change: 'slower' } } }] : [{ text: 'I could not change that just now.' }])) as unknown as typeof fetch;
    const chat = createConversation({ apiKey: 'k', model: 'm', systemInstruction: 'SYS', tools: [ADJUST_DELIVERY_TOOL], onToolCall: async () => { throw new Error('store locked'); } }, fetchImpl);
    expect(await chat.turn('too fast')).toBe('I could not change that just now.');
  });

  test('without a handler no tools are offered at all (baseline)', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return reply([{ text: 'ok' }]); }) as unknown as typeof fetch;
    await createConversation({ apiKey: 'k', model: 'm', systemInstruction: 'SYS' }, fetchImpl).turn('that was too fast');
    expect(bodies[0].tools).toBeUndefined();
  });
});
