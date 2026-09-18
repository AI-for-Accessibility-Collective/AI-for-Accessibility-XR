// profile-editor.test.ts — the profile editor end to end below HTTP: the
// host write path (writeNeed / resetProfile on a real toolkit store in a temp
// dir), the catalog's validation, the API shape both web surfaces serve, and
// the live session picking an edit up. No network, no Gemini.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootToolkit, readModel, resetProfile, writeNeed, EDITOR_SOURCE, type GuideToolkit } from '../src/toolkit/host.ts';
import { checkNeedValue, NEED_SPECS } from '../src/toolkit/needs-catalog.ts';
import { createProfileApi, type ProfileView } from '../src/transport/profile-api.ts';
import { renderXRAudioSettings } from '../src/toolkit-candidates/xr-audio.ts';
import { createSession, type SessionState } from '../src/runtime/session.ts';
import { createSpeaker } from '../src/audio/speaker.ts';
import { FrameStore } from '../src/transport/frames.ts';
import type { TurnEngine } from '../src/engine/engine.ts';
import fixture from './fixtures/margaret.blob.json';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wearable-ext-profile-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function bootMargaret(): Promise<GuideToolkit> {
  const tk = await bootToolkit({ dataDir: tempDir(), actingUser: 'margaret' });
  const res = await tk.librarian.importProfileBlob(fixture as never);
  expect(res.ok).toBe(true);
  return tk;
}

const needOf = (view: ProfileView, key: string) => view.needs.find((n) => n.key === key);

const idleState = (mode: SessionState['mode'] = 'toolkit', profileOn = true): SessionState => ({
  mode,
  profileOn,
  needs: [],
  captionsMirror: false,
  rate: 1,
  deliveryMode: 'continuous',
  task: null,
  paused: true,
  switching: false,
});

describe('writeNeed (host.ts)', () => {
  test('read → update one need → read reflects it, the others untouched', async () => {
    const tk = await bootMargaret();
    expect(renderXRAudioSettings(await readModel(tk)).delivery.mode).toBe('stepwise');

    const model = await writeNeed(tk, 'pacing', 'continuous');
    expect(renderXRAudioSettings(model).delivery.mode).toBe('continuous');
    const again = await readModel(tk);
    const byDim = new Map(again!.needs!.map((n) => [n.dimension, n]));
    expect(byDim.get('pacing')).toMatchObject({ value: 'continuous', strength: 'preference', source: EDITOR_SOURCE });
    // Provenance on the needs that were not edited survives.
    expect(byDim.get('captions')).toMatchObject({ value: true, source: 'onboarding-derived' });
    expect(byDim.get('readAloudRate')).toMatchObject({ value: 0.8, source: 'setup-script' });
    expect(byDim.size).toBe(5);
  });

  test('adds a need the profile did not have, and clears one with null', async () => {
    const tk = await bootMargaret();
    await writeNeed(tk, 'spokenDetail', 'gist');
    expect((await readModel(tk))!.needs!.map((n) => n.dimension).sort()).toEqual(['captions', 'clarity', 'pacing', 'readAloudRate', 'simplify', 'spokenDetail']);
    await writeNeed(tk, 'spokenDetail', null);
    await writeNeed(tk, 'captions', null);
    expect((await readModel(tk))!.needs!.map((n) => n.dimension).sort()).toEqual(['clarity', 'pacing', 'readAloudRate', 'simplify']);
  });

  test('writes are serialized: many quick slider moves end on the last value', async () => {
    const tk = await bootMargaret();
    await Promise.all([0.9, 1.0, 1.1, 1.2, 0.7].map((v) => writeNeed(tk, 'readAloudRate', v)));
    const model = await readModel(tk);
    expect(model!.needs!.filter((n) => n.dimension === 'readAloudRate')).toHaveLength(1);
    expect(renderXRAudioSettings(model).speech.rate).toBe(0.7);
  });

  test('persists on disk: a second handle over the same dir reads the edit', async () => {
    const dir = tempDir();
    const a = await bootToolkit({ dataDir: dir, actingUser: 'margaret' });
    await a.librarian.importProfileBlob(fixture as never);
    await writeNeed(a, 'simplify', false);
    const b = await bootToolkit({ dataDir: dir, actingUser: 'margaret' });
    expect(renderXRAudioSettings(await readModel(b)).language.simplify).toBe(false);
  });
});

describe('resetProfile (host.ts)', () => {
  test('after edits, reset restores exactly the fixture profile', async () => {
    const tk = await bootMargaret();
    await writeNeed(tk, 'pacing', 'continuous');
    await writeNeed(tk, 'readAloudRate', 1.2);
    await writeNeed(tk, 'voicePitch', 'low');
    await writeNeed(tk, 'captions', null);

    const model = await resetProfile(tk, fixture);
    expect(model!.needs).toEqual(fixture.profile.fields.needs as never);
    expect(model!.supportAreas!.sort()).toEqual(['cognitive', 'hearing']);
    const render = renderXRAudioSettings(await readModel(tk));
    expect(render.speech.rate).toBe(0.8);
    expect(render.delivery.mode).toBe('stepwise');
    expect(render.captionsMirror).toBe(true);
  });

  test("the plain import would be refused as older than the edit — that's why reset re-stamps", async () => {
    const tk = await bootMargaret();
    await writeNeed(tk, 'pacing', 'continuous');
    const res = await tk.librarian.importProfileBlob(fixture as never);
    expect(res).toMatchObject({ ok: true, merged: false, reason: 'older-or-equal' });
    expect(renderXRAudioSettings(await readModel(tk)).delivery.mode).toBe('continuous');
    await resetProfile(tk, fixture);
    expect(renderXRAudioSettings(await readModel(tk)).delivery.mode).toBe('stepwise');
  });

  test('reset twice in a row is still a reset (no tie on the clock)', async () => {
    const tk = await bootMargaret();
    await resetProfile(tk, fixture);
    await writeNeed(tk, 'simplify', false);
    await resetProfile(tk, fixture);
    expect(renderXRAudioSettings(await readModel(tk)).language.simplify).toBe(true);
  });

  test('a corrupted blob is refused before anything is written', async () => {
    const tk = await bootMargaret();
    await expect(resetProfile(tk, { ...fixture, kind: 'wrong' })).rejects.toThrow(/validateProfileBlob/);
    expect(renderXRAudioSettings(await readModel(tk)).delivery.mode).toBe('stepwise');
  });
});

describe('needs catalog', () => {
  test('every dimension the XR audio surface reads has a control', () => {
    expect(NEED_SPECS.map((s) => s.key).sort()).toEqual(['captions', 'clarity', 'pacing', 'readAloudRate', 'simplify', 'spokenDetail', 'voicePitch']);
  });
  test('accepts the allowed values, snapping numbers to the step', () => {
    expect(checkNeedValue('pacing', 'stepwise')).toEqual({ ok: true, value: 'stepwise' });
    expect(checkNeedValue('simplify', false)).toEqual({ ok: true, value: false });
    expect(checkNeedValue('readAloudRate', 0.8000000001)).toEqual({ ok: true, value: 0.8 });
    expect(checkNeedValue('readAloudRate', '1.1')).toEqual({ ok: true, value: 1.1 });
  });
  test('rejects the wrong type, an unknown option, out of range, unknown need', () => {
    expect(checkNeedValue('simplify', 'yes').ok).toBe(false);
    expect(checkNeedValue('pacing', 'fast').ok).toBe(false);
    expect(checkNeedValue('readAloudRate', 2).ok).toBe(false);
    expect(checkNeedValue('readAloudRate', 'quick').ok).toBe(false);
    expect(checkNeedValue('textSize', 1.4).ok).toBe(false);
    expect(checkNeedValue('__proto__', true).ok).toBe(false);
  });
});

describe('profile API (both web surfaces)', () => {
  test('GET: set needs as controls, unset ones under available, mode + profileOn from the session', async () => {
    const tk = await bootMargaret();
    const api = createProfileApi({ toolkit: () => tk, sessionState: () => idleState('toolkit', true) });
    const r = await api.get();
    expect(r.status).toBe(200);
    const view = r.body as ProfileView;
    expect(view).toMatchObject({ mode: 'toolkit', profileOn: true });
    expect(view.supportAreas.sort()).toEqual(['cognitive', 'hearing']);
    expect(view.needs.map((n) => n.key)).toEqual(['pacing', 'clarity', 'simplify', 'readAloudRate', 'captions']);
    // The effect lines are the surface's answer for this profile, so an edit
    // shows what it changes: pacing off → the first line flips.
    expect(view.effect).toEqual([
      'One step at a time, then waits for you',
      'Speaks at 0.8× speed',
      'Short sentences (about 12 words)',
      'Says what to do first, then where',
      'One new thing per sentence',
      'Asks a question instead of "if…"',
      'Plain everyday words, never jargon',
      'The same word for the same thing',
      'Gist first, details on request',
      'Captions on the display',
    ]);
    // …and each need shows the lines it alone is responsible for.
    expect(needOf(view, 'simplify')?.effect).toEqual(['Plain everyday words, never jargon', 'The same word for the same thing', 'Gist first, details on request']);
    // Clear IS the default, so setting it explicitly is responsible for nothing…
    expect(needOf(view, 'clarity')?.effect).toEqual([]);
    expect(needOf(view, 'captions')?.effect).toEqual(['Captions on the display']);
    const after = (await api.set({ key: 'pacing', value: 'continuous' })).body as ProfileView;
    expect(after.effect[0]).toBe('Whole answer at once');
    // Clarity adds its lines, and they are attributed to it.
    const clear = (await api.set({ key: 'clarity', value: 'clearest' })).body as ProfileView;
    // …while 'clearest' adds the step number and the tighter cap on top of it.
    expect(needOf(clear, 'clarity')?.effect).toEqual(['Short sentences (about 8 words)', 'Says which step you are on']);
    expect(view.available.map((n) => n.key)).toEqual(['spokenDetail', 'voicePitch']);
    expect(needOf(view, 'pacing')).toMatchObject({
      kind: 'choice',
      value: 'stepwise',
      label: 'Pacing',
      strength: 'preference',
      source: 'setup-script',
      options: [
        { value: 'continuous', label: 'All at once' },
        { value: 'stepwise', label: 'One step at a time' },
      ],
    });
    expect(needOf(view, 'readAloudRate')).toMatchObject({ kind: 'range', value: 0.8, min: 0.7, max: 1.2, step: 0.1, unit: '×' });
    expect(needOf(view, 'captions')).toMatchObject({ kind: 'toggle', value: true, source: 'onboarding-derived' });
    for (const n of view.needs) expect(typeof n.help).toBe('string');
    for (const a of view.available) expect(a).toHaveProperty('default');
  });

  test('profileOn is false in baseline even though the store has the profile', async () => {
    const tk = await bootMargaret();
    const api = createProfileApi({ toolkit: () => tk, sessionState: () => idleState('baseline', false) });
    const view = (await api.get()).body as ProfileView;
    expect(view).toMatchObject({ mode: 'baseline', profileOn: false });
    expect(view.needs).toHaveLength(5); // still editable
  });

  test('POST: one change is saved, the session is told, the fresh profile comes back', async () => {
    const tk = await bootMargaret();
    let refreshed = 0;
    const api = createProfileApi({
      toolkit: () => tk,
      sessionState: () => idleState(),
      onProfileChanged: () => void refreshed++,
    });
    const r = await api.set({ key: 'pacing', value: 'continuous' });
    expect(r.status).toBe(200);
    expect(needOf(r.body as ProfileView, 'pacing')).toMatchObject({ value: 'continuous', source: EDITOR_SOURCE });
    expect(refreshed).toBe(1);
    expect(renderXRAudioSettings(await readModel(tk)).delivery.mode).toBe('continuous');
  });

  test('POST: adding an available need moves it into needs; null removes it again', async () => {
    const tk = await bootMargaret();
    const api = createProfileApi({ toolkit: () => tk, sessionState: () => idleState() });
    let view = (await api.set({ key: 'spokenDetail', value: 'gist' })).body as ProfileView;
    expect(needOf(view, 'spokenDetail')).toMatchObject({ value: 'gist' });
    expect(view.available.map((n) => n.key)).toEqual(['voicePitch']);
    view = (await api.set({ key: 'spokenDetail', value: null })).body as ProfileView;
    expect(needOf(view, 'spokenDetail')).toBeUndefined();
    expect(view.available.map((n) => n.key)).toEqual(['spokenDetail', 'voicePitch']);
  });

  test('POST: invalid key / value → 400 with a reason, nothing written, session not told', async () => {
    const tk = await bootMargaret();
    let refreshed = 0;
    const api = createProfileApi({ toolkit: () => tk, sessionState: () => idleState(), onProfileChanged: () => void refreshed++ });
    const before = await tk.librarian.exportProfileBlob();
    for (const body of [
      { key: 'pacing', value: 'fast' },
      { key: 'readAloudRate', value: 3 },
      { key: 'simplify', value: 'on' },
      { key: 'textSize', value: 1.4 },
      { value: true },
      'garbage',
      null,
    ]) {
      const r = await api.set(body);
      expect(r.status).toBe(400);
      expect(typeof (r.body as { error: string }).error).toBe('string');
    }
    expect(refreshed).toBe(0);
    expect((await tk.librarian.exportProfileBlob()).profile).toEqual(before.profile);
  });

  test('POST /profile/reset restores the fixture after edits', async () => {
    const tk = await bootMargaret();
    const api = createProfileApi({ toolkit: () => tk, sessionState: () => idleState() });
    await api.set({ key: 'readAloudRate', value: 1.2 });
    await api.set({ key: 'captions', value: false });
    const r = await api.reset();
    expect(r.status).toBe(200);
    const view = r.body as ProfileView;
    expect(needOf(view, 'readAloudRate')).toMatchObject({ value: 0.8, source: 'setup-script' });
    expect(needOf(view, 'captions')).toMatchObject({ value: true, source: 'onboarding-derived' });
  });

  test('no store yet (glasses app before a phone connects) → 409, never a crash', async () => {
    const api = createProfileApi({ toolkit: () => null, sessionState: () => idleState('baseline', false) });
    expect((await api.get()).status).toBe(409);
    expect((await api.set({ key: 'captions', value: true })).status).toBe(409);
    expect((await api.reset()).status).toBe(409);
  });
});

describe('the live session picks an edit up', () => {
  async function rig() {
    const tk = await bootMargaret();
    const instructions: string[] = [];
    const makeEngine = (si: string): TurnEngine => ({
      turn: async () => {
        instructions.push(si);
        return 'Open the drawer.';
      },
      reset() {},
    });
    const speaker = createSpeaker({ speak: async () => {} }, undefined, { sleep: async () => {} });
    const session = createSession({
      frames: new FrameStore(3),
      speaker,
      makeEngine,
      tk,
      panel: { emit: () => {} },
      tasks: [],
      vision: null,
      initialMode: 'baseline',
    });
    const api = createProfileApi({ toolkit: () => tk, sessionState: () => session.state(), onProfileChanged: () => session.refreshProfile() });
    return { tk, session, api, instructions };
  }

  test('toolkit mode: delivery changes at once, the next turn gets the new prompt block', async () => {
    const r = await rig();
    await r.session.setMode('toolkit');
    expect(r.session.state()).toMatchObject({ deliveryMode: 'stepwise', rate: 0.8 });
    await r.session.onUtterance('hello there');
    expect(r.instructions.at(-1)).toContain('ONE next action');

    const res = await r.api.set({ key: 'pacing', value: 'continuous' });
    expect(res.body).toMatchObject({ mode: 'toolkit', profileOn: true });
    expect(r.session.state()).toMatchObject({ deliveryMode: 'continuous', rate: 0.8, profileOn: true });
    expect(r.session.state().needs.find((n) => n.dimension === 'pacing')).toMatchObject({ value: 'continuous', source: EDITOR_SOURCE });

    await r.session.onUtterance('and again');
    expect(r.instructions.at(-1)).not.toContain('ONE next action');
    expect(r.instructions.at(-1)).toContain('Plain everyday words'); // simplify still on

    await r.api.set({ key: 'readAloudRate', value: 1.1 });
    expect(r.session.state().rate).toBe(1.1);
    expect(r.session.render().delivery.mode).toBe('continuous');
  });

  test('baseline mode: the edit is saved but the session stays unshaped; toolkit mode then reads it', async () => {
    const r = await rig();
    await r.session.setMode('baseline');
    const res = await r.api.set({ key: 'readAloudRate', value: 1.2 });
    expect(res.body).toMatchObject({ mode: 'baseline', profileOn: false });
    expect(r.session.state()).toMatchObject({ mode: 'baseline', profileOn: false, rate: 1, deliveryMode: 'continuous' });
    await r.session.setMode('toolkit');
    expect(r.session.state()).toMatchObject({ profileOn: true, rate: 1.2, deliveryMode: 'stepwise' });
  });
});
