// host.test.ts — the Phase 4 acceptance in test form: the spoken-consent
// grant beat (all four scopes), readModel's granted slice (freeText excluded
// by scope), decline handling, and the insight beat end-to-end (two repeats →
// proposal → accept → the model, render, and prompt block all update; decline
// → nothing applied). Everything runs on real toolkit stores in temp dirs.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootToolkit, ensureGrant, readModel, proposeInsight, APP_ID, APP_SCOPES, type GuideToolkit } from '../src/toolkit/host.ts';
import { audioConsent, parseConsentAnswer, type ConsentCard } from '../src/toolkit/consent-audio.ts';
import { renderAudioSettings } from '../src/audio/render.ts';
import { profilePromptBlock } from '../src/toolkit/prompt-block.ts';
import fixture from './fixtures/margaret.blob.json';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wearable-ext-host-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A scripted wearer: answers consent questions from a queue, records what was
// spoken to them and which cards were shown.
function scriptedIO(answers: Array<string | null>) {
  const spoken: string[] = [];
  const cards: Array<ConsentCard | null> = [];
  return {
    io: {
      speak: async (t: string) => void spoken.push(t),
      showCard: (c: ConsentCard | null) => void cards.push(c),
      nextUtterance: async () => answers.shift() ?? null,
    },
    spoken,
    cards,
  };
}

async function bootMargaret(answers: Array<string | null>): Promise<{ tk: GuideToolkit; spoken: string[]; cards: Array<ConsentCard | null> }> {
  const { io, spoken, cards } = scriptedIO(answers);
  const tk = await bootToolkit({ dataDir: tempDir(), actingUser: 'margaret', consent: audioConsent(io) });
  const res = await tk.librarian.importProfileBlob(fixture as never);
  expect(res.ok).toBe(true);
  return { tk, spoken, cards };
}

describe('parseConsentAnswer', () => {
  test('yes variants', () => {
    for (const t of ['yes', 'Yeah, okay', 'sure', "that's fine", 'OK', 'yes please', 'Yes, that is okay.']) expect(parseConsentAnswer(t)).toBe('accept');
  });
  test('no variants — and no beats an embedded okay', () => {
    for (const t of ['no', 'not now', "no, that's okay actually", 'later please']) expect(parseConsentAnswer(t)).toBe('declineOnce');
  });
  test('non-answers', () => {
    expect(parseConsentAnswer('what was that?')).toBeNull();
    expect(parseConsentAnswer(null)).toBeNull();
  });
  test('hedges, confusion and requests are not consent, even with "sure", "okay" or "please" in them', () => {
    for (const t of [
      "I'm not sure",
      "I'm not so sure",
      'Could you repeat that please?',
      'okay, which button now?',
      'Please help me start the washing machine',
      "I don't understand",
      'no idea',
      'sorry, what?',
      'Okay, let me think',
      'sure, hold on',
      'is that okay',
      'you can say yes',
      "That's not okay",
      'not okay',
      'Okay?',
    ]) {
      expect(parseConsentAnswer(t)).toBeNull();
    }
  });
  test('a plain refusal without a yes-word declines', () => {
    for (const t of ["I'd rather not", "don't", 'nah', 'maybe later']) expect(parseConsentAnswer(t)).toBe('declineOnce');
  });
  test('yes-phrases count only when the whole reply is yes', () => {
    for (const t of ['sounds good', 'yes please go ahead', 'of course', "I don't mind"]) expect(parseConsentAnswer(t)).toBe('accept');
    expect(parseConsentAnswer('yes but which button')).toBeNull();
  });
});

describe('an answer that lands during the re-ask', () => {
  test('a tap while "was that a yes or a no?" plays grants — capture then hearing nothing is not "pending"', async () => {
    let cardId = '';
    let tk: GuideToolkit | null = null;
    const heard: Array<string | null> = ['what?', null];
    const consent = audioConsent({
      showCard: (c) => {
        if (c) cardId = c.id;
      },
      speak: async (t) => {
        if (/yes or a no/.test(t)) await tk!.librarian.respondToProposal(cardId, 'accept');
      },
      nextUtterance: async () => heard.shift() ?? null,
    });
    tk = await bootToolkit({ dataDir: tempDir(), actingUser: 'margaret', consent });
    await tk.librarian.importProfileBlob(fixture as never);
    expect(await ensureGrant(tk)).toBe('granted');
    expect(await readModel(tk)).not.toBeNull();
  });
});

describe('the grant beat', () => {
  test('spoken yes mints the grant with ALL four scopes', async () => {
    const { tk, spoken, cards } = await bootMargaret(['yes please']);
    expect(await ensureGrant(tk)).toBe('granted');
    const grants = await tk.librarian.listGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.appId).toBe(APP_ID);
    expect(grants[0]!.scopes.sort()).toEqual([...APP_SCOPES].sort());
    // The consent copy was actually spoken and names the reading level.
    expect(spoken.join(' ')).toContain('needs, speech, and reading level');
    // Card shown, then cleared after the decision.
    expect(cards[0]?.kind).toBe('grant');
    expect(cards.at(-1)).toBeNull();
  });

  test('already granted: second call is instant, no re-ask', async () => {
    const { tk, spoken } = await bootMargaret(['yes']);
    await ensureGrant(tk);
    const asked = spoken.length;
    expect(await ensureGrant(tk)).toBe('granted');
    expect(spoken.length).toBe(asked); // nothing new spoken
  });

  test('spoken no declines; readModel stays null (baseline fallback)', async () => {
    const { tk } = await bootMargaret(['no, not now']);
    expect(await ensureGrant(tk)).toBe('declined');
    expect(await tk.librarian.listGrants()).toHaveLength(0);
    expect(await readModel(tk)).toBeNull();
  });

  test('silence leaves it pending — no grant minted, card stays up', async () => {
    const { tk, cards } = await bootMargaret([null]);
    expect(await ensureGrant(tk)).toBe('pending');
    expect(await tk.librarian.listGrants()).toHaveLength(0);
    expect(cards.at(-1)).not.toBeNull();
    expect((await tk.librarian.listProposals('pending')).length).toBe(1);
  });

  test('an unclear answer gets one re-ask, then the second answer lands', async () => {
    const { tk, spoken } = await bootMargaret(['what?', 'yes']);
    expect(await ensureGrant(tk)).toBe('granted');
    expect(spoken.some((s) => s.includes('yes or a no'))).toBe(true);
  });
});

describe('answers that land while the question is still being spoken', () => {
  // The panel card is live from the first word of the question, and a quick
  // "yes" can arrive before capture starts listening. Both resolve the
  // proposal directly (the session's card path) — simulated here by the speak
  // hook answering mid-question.
  async function bootAnswering(response: 'accept' | 'declineOnce') {
    let cardId = '';
    let listened = 0;
    let tk: GuideToolkit | null = null;
    const consent = audioConsent({
      showCard: (c) => {
        if (c) cardId = c.id;
      },
      speak: async () => {
        await tk!.librarian.respondToProposal(cardId, response);
      },
      nextUtterance: async () => {
        listened++;
        return null;
      },
    });
    tk = await bootToolkit({ dataDir: tempDir(), actingUser: 'margaret', consent });
    await tk.librarian.importProfileBlob(fixture as never);
    return { tk, listened: () => listened };
  }

  test('a mid-question tap grants — never reported pending, never listens', async () => {
    const { tk, listened } = await bootAnswering('accept');
    expect(await ensureGrant(tk)).toBe('granted');
    expect(listened()).toBe(0); // would otherwise swallow the wearer's next sentence
    expect(await readModel(tk)).not.toBeNull();
  });

  test('a mid-question "not now" declines without listening', async () => {
    const { tk, listened } = await bootAnswering('declineOnce');
    expect(await ensureGrant(tk)).toBe('declined');
    expect(listened()).toBe(0);
    expect(await tk.librarian.listGrants()).toHaveLength(0);
  });
});

describe('readModel — the granted slice', () => {
  test('carries needs + areas + readingLevel + language, NEVER freeText', async () => {
    const { tk } = await bootMargaret(['yes']);
    // Put something sensitive in freeText on the store side.
    await tk.librarian.setProfileField('freeText', 'my daughter Ruth manages my bank account');
    await ensureGrant(tk);
    const model = await readModel(tk);
    expect(model).not.toBeNull();
    expect(model!.needs).toHaveLength(4);
    expect(model!.supportAreas!.sort()).toEqual(['cognitive', 'hearing']);
    expect('language' in model!).toBe(true);
    expect('readingLevel' in model!).toBe(true);
    expect(model!.freeText).toBeUndefined(); // scope projection excludes it
    // …and therefore the prompt block cannot contain it either.
    const block = profilePromptBlock(model, renderAudioSettings(model));
    expect(block).not.toContain('Ruth');
  });
});

describe('the insight beat', () => {
  test('propose → accept → model + render + prompt block all update', async () => {
    const { tk } = await bootMargaret(['yes']);
    await ensureGrant(tk);
    const before = await readModel(tk);
    const beforeRender = renderAudioSettings(before);
    expect(beforeRender.speech.rate).toBe(0.8);

    const needs = (before!.needs ?? []).map((n) => ({ ...n }));
    needs.find((n) => n.dimension === 'readAloudRate')!.value = 0.7;
    const proposal = await proposeInsight(
      tk,
      'speech.readAloudRate',
      { op: 'profile-set', path: 'fields.needs', value: needs },
      'You asked me to repeat twice — speak slower from now on?',
      'Speak a bit slower',
    );
    expect(proposal).not.toBeNull();

    // Nothing applied before the accept.
    expect(renderAudioSettings(await readModel(tk)).speech.rate).toBe(0.8);

    const res = await tk.librarian.respondToProposal(proposal!.id, 'accept');
    expect(res.ok).toBe(true);

    const after = await readModel(tk);
    const afterRender = renderAudioSettings(after);
    expect(afterRender.speech.rate).toBe(0.7);
    // The NEXT prompt block reflects it too (calm-pacing directive still on).
    expect(profilePromptBlock(after, afterRender)).toContain('Calm, unhurried');
    // Provenance survived the write.
    expect(after!.needs!.find((n) => n.dimension === 'readAloudRate')!.source).toBe('setup-script');
  });

  test('declineOnce applies nothing', async () => {
    const { tk } = await bootMargaret(['yes']);
    await ensureGrant(tk);
    const model = await readModel(tk);
    const needs = (model!.needs ?? []).map((n) => (n.dimension === 'readAloudRate' ? { ...n, value: 0.7 } : n));
    const proposal = await proposeInsight(tk, 'speech.readAloudRate', { op: 'profile-set', path: 'fields.needs', value: needs }, 'slower?');
    const res = await tk.librarian.respondToProposal(proposal!.id, 'declineOnce');
    expect(res.ok).toBe(true);
    expect(renderAudioSettings(await readModel(tk)).speech.rate).toBe(0.8);
  });

  test('an ungranted app cannot even propose', async () => {
    const { tk } = await bootMargaret([]);
    const res = await tk.librarian.importInsight(APP_ID, {
      kind: 'x',
      change: { op: 'profile-set', path: 'fields.needs', value: [] },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-grant');
  });
});
