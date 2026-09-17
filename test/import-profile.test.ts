// import-profile.test.ts — fixture blob → temp store → exactly the 4 needs
// with accurate sources; the validateProfileBlob gate; reset-take semantics
// (a fresh store has no grants/proposals but keeps the profile).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProfileBlob } from '@ai4a11y/toolkit';
import { bootToolkit, ensureGrant, APP_ID, APP_SCOPES, type GuideToolkit } from '../src/toolkit/host.ts';
import fixture from './fixtures/margaret.blob.json';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wearable-ext-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function bootWithFixture(dir: string): Promise<GuideToolkit> {
  const tk = await bootToolkit({ dataDir: dir, actingUser: 'margaret' });
  const res = await tk.librarian.importProfileBlob(fixture as never);
  expect(res.ok).toBe(true);
  return tk;
}

// Auto-accepting consent for tests that need the grant minted.
function autoConsent(): GuideToolkit['consent'] {
  return {
    notifyPending() {},
    present: async () => {},
    capture: async () => 'accept' as const,
  };
}

describe('fixture blob', () => {
  test('passes validateProfileBlob', () => {
    expect(validateProfileBlob(fixture)).toBe(true);
  });
  test('a corrupted blob is refused by the gate', () => {
    expect(validateProfileBlob({ ...fixture, kind: 'wrong' })).toBe(false);
    expect(validateProfileBlob({ ...fixture, exportedAt: NaN })).toBe(false);
  });
});

describe('import into a fresh store', () => {
  test('exactly the 4 needs, accurate sources, no stray reduceMotion', async () => {
    const tk = await bootWithFixture(tempDir());
    const model = await tk.librarian.getAbilityModel();
    const byDim = new Map(model.needs.map((n) => [n.dimension, n]));
    expect([...byDim.keys()].sort()).toEqual(['captions', 'pacing', 'readAloudRate', 'simplify']);
    expect(byDim.get('readAloudRate')).toMatchObject({ value: 0.8, source: 'setup-script' });
    expect(byDim.get('pacing')).toMatchObject({ value: 'stepwise', source: 'setup-script' });
    expect(byDim.get('simplify')).toMatchObject({ value: true, source: 'onboarding-derived' });
    expect(byDim.get('captions')).toMatchObject({ value: true, source: 'onboarding-derived' });
    expect(model.supportAreas.sort()).toEqual(['cognitive', 'hearing']);
  });

  test('round trip: export from one store, import into another, models match', async () => {
    const a = await bootWithFixture(tempDir());
    const blob = await a.librarian.exportProfileBlob();
    expect(validateProfileBlob(blob)).toBe(true);

    const b = await bootToolkit({ dataDir: tempDir(), actingUser: 'margaret' });
    const res = await b.librarian.importProfileBlob(blob);
    expect(res.ok).toBe(true);
    const modelA = await a.librarian.getAbilityModel();
    const modelB = await b.librarian.getAbilityModel();
    expect(modelB.needs).toEqual(modelA.needs);
    expect(modelB.supportAreas).toEqual(modelA.supportAreas);
  });

  test('re-import of the same blob is idempotent', async () => {
    const tk = await bootWithFixture(tempDir());
    const again = await tk.librarian.importProfileBlob(fixture as never);
    expect(again.ok).toBe(true);
    const model = await tk.librarian.getAbilityModel();
    expect(model.needs).toHaveLength(4);
  });
});

describe('reset-take semantics', () => {
  test('wipe + re-import returns the store to pre-consent state', async () => {
    // Take 1: fixture + grant minted (the consent beat has run).
    const dir = tempDir();
    let tk = await bootToolkit({ dataDir: dir, actingUser: 'margaret', consent: autoConsent() });
    await tk.librarian.importProfileBlob(fixture as never);
    expect(await ensureGrant(tk)).toBe('granted');
    expect(await tk.librarian.listGrants()).toHaveLength(1);

    // Retake: wipe the dir, boot fresh, re-import the fixture.
    rmSync(dir, { recursive: true, force: true });
    tk = await bootToolkit({ dataDir: dir, actingUser: 'margaret', consent: autoConsent() });
    await tk.librarian.importProfileBlob(fixture as never);

    expect(await tk.librarian.listGrants()).toHaveLength(0); // pre-consent
    expect(await tk.librarian.listProposals('pending')).toHaveLength(0);
    const model = await tk.librarian.getAbilityModel();
    expect(model.needs).toHaveLength(4); // profile is back

    // …and the whole consent beat replays cleanly on the fresh store.
    expect(await ensureGrant(tk)).toBe('granted');
    const grants = await tk.librarian.listGrants();
    expect(grants[0]?.appId).toBe(APP_ID);
    expect(grants[0]?.scopes.sort()).toEqual([...APP_SCOPES].sort());
  });
});
