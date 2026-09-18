// host.test.ts — the app's whole surface onto the toolkit: bootToolkit opens
// the store, readModel returns the structured profile (needs, support areas,
// reading level, language) with the person's free text and the confidence
// score left behind, and an empty store reads as null (the defaults
// fallback). Everything runs on real toolkit stores in temp dirs.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootToolkit, readModel, type GuideToolkit } from '../src/toolkit/host.ts';
import { renderXRAudioSettings } from '../src/toolkit-candidates/xr-audio.ts';
import { profilePromptBlock } from '../src/toolkit-candidates/adapters/prompt-directives.ts';
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

async function bootMargaret(): Promise<GuideToolkit> {
  const tk = await bootToolkit({ dataDir: tempDir(), actingUser: 'margaret' });
  const res = await tk.librarian.importProfileBlob(fixture as never);
  expect(res.ok).toBe(true);
  return tk;
}

const SECRET = 'my daughter Ruth manages my bank account';

describe('readModel', () => {
  test('reads the profile straight away — nothing to ask, nothing to wait for', async () => {
    const tk = await bootMargaret();
    const model = await readModel(tk);
    expect(model).not.toBeNull();
    expect(model!.needs!.map((n) => n.dimension).sort()).toEqual(['captions', 'pacing', 'readAloudRate', 'simplify']);
    expect(model!.supportAreas!.sort()).toEqual(['cognitive', 'hearing']);
    const render = renderXRAudioSettings(model);
    expect(render.speech.rate).toBe(0.8);
    expect(render.delivery.mode).toBe('stepwise');
  });

  test('carries needs + areas + readingLevel + language, NEVER freeText or confidence', async () => {
    const tk = await bootMargaret();
    await tk.librarian.setProfileField('freeText', SECRET);
    await tk.librarian.setProfileField('fields.confidence', 0.4);
    await tk.librarian.setProfileField('fields.readingLevel', 'grade 6');
    await tk.librarian.setProfileField('metaPreferences.language', 'plain');
    // The toolkit's own read does return the free text…
    expect((await tk.librarian.getAbilityModel()).freeText).toBe(SECRET);
    // …readModel is where it stops.
    const model = await readModel(tk);
    expect(Object.keys(model!).sort()).toEqual(['language', 'needs', 'readingLevel', 'schemaVersion', 'supportAreas']);
    expect(model!.readingLevel).toBe('grade 6');
    expect(model!.language).toBe('plain');
    expect(JSON.stringify(model)).not.toContain('Ruth');
    // The render and the prompt block see reading level and language…
    const render = renderXRAudioSettings(model);
    expect(render.language).toMatchObject({ readingLevel: 'grade 6', language: 'plain' });
    const block = profilePromptBlock(model, render);
    expect(block).toContain('grade 6 reading level');
    expect(block).toContain('plain language');
    // …and never the free text.
    expect(block).not.toContain('Ruth');
  });

  test('an empty store reads as null (the caller falls back to defaults)', async () => {
    const tk = await bootToolkit({ dataDir: tempDir(), actingUser: 'margaret' });
    expect(await readModel(tk)).toBeNull();
  });

  test("another person's partition is not read", async () => {
    const dir = tempDir();
    const margaret = await bootToolkit({ dataDir: dir, actingUser: 'margaret' });
    await margaret.librarian.importProfileBlob(fixture as never);
    const other = await bootToolkit({ dataDir: dir, actingUser: 'someone-else' });
    expect(await readModel(other)).toBeNull();
  });

  test('reading never writes to the profile', async () => {
    const tk = await bootMargaret();
    const before = await tk.librarian.exportProfileBlob();
    await readModel(tk);
    await readModel(tk);
    const after = await tk.librarian.exportProfileBlob();
    expect(after.profile).toEqual(before.profile);
  });
});

describe('bootToolkit', () => {
  test('opens a file store in the data folder', async () => {
    const dir = tempDir();
    const tk = await bootToolkit({ dataDir: dir, actingUser: 'margaret' });
    await tk.librarian.importProfileBlob(fixture as never);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    expect(tk.librarian.getActingUser().id).toBe('margaret');
  });
});
