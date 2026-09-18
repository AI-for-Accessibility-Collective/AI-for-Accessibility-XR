// import-profile.test.ts — fixture blob → temp store → exactly the 4 needs
// with accurate sources; the validateProfileBlob gate; round trip and
// idempotent re-import.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProfileBlob } from '@ai4a11y/toolkit';
import { bootToolkit, type GuideToolkit } from '../src/toolkit/host.ts';
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
    expect([...byDim.keys()].sort()).toEqual(['captions', 'clarity', 'pacing', 'readAloudRate', 'simplify']);
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
    expect(model.needs).toHaveLength(5);
  });
});
