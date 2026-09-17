#!/usr/bin/env bun
// Profile transfer: onboarding store → portable blob → the app's own store
// (docs/PLAN.md §3.7). Protocol-v1 aa-profile-blob, via the toolkit's public
// exportProfileBlob/importProfileBlob only.
//
//   bun scripts/import-profile.mjs --uid margaret --seed \
//     --from ../AI-for-Accessibility-Toolkit/onboarding/onboarding-data \
//     --to ./data
//
//   bun scripts/import-profile.mjs --fixture            # no onboarding needed
//
// **Run only while the onboarding server is stopped** — the stores are
// single-writer, and this script opens the onboarding store directly (via the
// cleaned repo's own server/src helpers, so the layout matches byte-for-byte).
//
// --seed is REQUIRED for the demo profile (docs/DESIGN.md §3): the onboarding
// page only writes per-area default needs (captions, simplify, plus a stray
// reduceMotion) and never parses free text — so readAloudRate/pacing cannot
// exist without this step. --seed replaces the derived needs array with
// Margaret's four, recording accurate sources, via public setProfileField.

import { readFile, writeFile } from 'node:fs/promises';
import { validateProfileBlob } from '@ai4a11y/toolkit';
import { arg, flag, bootAppStore, importBlob, printModel, MARGARET_NEEDS, MARGARET_AREAS } from './lib.mjs';

const uid = arg('uid', 'margaret');
const from = arg('from', '../AI-for-Accessibility-Toolkit/onboarding/onboarding-data');
const to = arg('to', process.env.APP_DATA_DIR || './data');
const seed = flag('seed');
const useFixture = flag('fixture');
const fixturePath = arg('fixture', new URL('../test/fixtures/margaret.blob.json', import.meta.url).pathname);
const saveFixture = flag('save-fixture');

let blob;

if (useFixture) {
  blob = JSON.parse(await readFile(fixturePath, 'utf8'));
  console.log(`[import-profile] using fixture blob: ${fixturePath}`);
} else {
  // Onboarding side, through the cleaned repo's own server helpers (fileStore
  // + createToolkitHost → getInstance(uid)) so the store layout is exactly
  // what the onboarding service wrote.
  const { fileStore } = await import(new URL('../../AI-for-Accessibility-Toolkit/server/src/store.js', import.meta.url).href);
  const { createToolkitHost } = await import(new URL('../../AI-for-Accessibility-Toolkit/server/src/toolkit-host.js', import.meta.url).href);

  const host = createToolkitHost({
    store: fileStore(from),
    geminiCaller: async () => {
      throw new Error('LLM is not available in the import script');
    },
  });
  const { librarian } = await host.getInstance(uid);

  const before = await librarian.getAbilityModel();
  printModel(before, `[import-profile] onboarding store (${from}) uid=${uid} — before:`);

  if (seed) {
    if (!(before.supportAreas || []).length) {
      await librarian.setProfileField('supportAreas', MARGARET_AREAS);
      console.log(`[import-profile] seeded supportAreas: ${MARGARET_AREAS.join(', ')} (store had none — onboard at :4000/onboarding to set them for real)`);
    }
    await librarian.setProfileField('fields.needs', MARGARET_NEEDS);
    console.log('[import-profile] --seed: replaced needs with Margaret\'s four (accurate sources; stray reduceMotion dropped)');
  }

  blob = await librarian.exportProfileBlob();
  if (!validateProfileBlob(blob)) {
    console.error('[import-profile] exported blob failed validateProfileBlob');
    process.exit(1);
  }
  if (saveFixture) {
    await writeFile(fixturePath, JSON.stringify(blob, null, 2) + '\n', 'utf8');
    console.log(`[import-profile] saved fixture: ${fixturePath}`);
  }
}

// App side: import into the wearable-extension store under the same uid.
const app = await bootAppStore(to, uid);
const model = await importBlob(app.librarian, blob);
printModel(model, `[import-profile] app store (${to}) uid=${uid} — after import:`);

const dims = (model.needs || []).map((n) => n.dimension).sort();
const expected = ['captions', 'pacing', 'readAloudRate', 'simplify'];
if (seed || useFixture) {
  const ok = expected.every((d) => dims.includes(d)) && !dims.includes('reduceMotion');
  console.log(ok
    ? '\n[import-profile] ✓ exactly the four demo needs present, no stray reduceMotion'
    : `\n[import-profile] ✗ unexpected needs set: [${dims.join(', ')}] (expected ${expected.join(', ')})`);
  if (!ok) process.exit(1);
}
