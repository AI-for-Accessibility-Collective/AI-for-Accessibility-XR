// Shared plumbing for the profile-transfer scripts (plain JS so they run
// under node or bun alike). App-side stores are built with the SAME toolkit
// package the app links (`@ai4a11y/toolkit`) and its own node file store.

import { createToolkit, validateProfileBlob } from '@ai4a11y/toolkit';
import { fileKV } from '@ai4a11y/toolkit/platforms/node/kv.js';

// Boot an app-side toolkit over `dir`, acting as `uid`.
export async function bootAppStore(dir, uid) {
  const { librarian, datastore } = createToolkit({
    kv: fileKV(dir),
    clock: { now: () => Date.now() },
  });
  await datastore.runMigrations();
  await librarian.setActingUser(uid);
  return { librarian, datastore };
}

// Validate + import a profile blob into the app store; returns the resulting
// AbilityModel so callers can print/verify it.
export async function importBlob(librarian, blob) {
  if (!validateProfileBlob(blob)) throw new Error('blob failed validateProfileBlob — refusing to import');
  const res = await librarian.importProfileBlob(blob);
  if (!res.ok) throw new Error(`importProfileBlob failed: ${res.reason}`);
  return await librarian.getAbilityModel();
}

export function printModel(model, header) {
  console.log(`\n${header}`);
  console.log(`  supportAreas: ${(model.supportAreas || []).join(', ') || '(none)'}`);
  const needs = model.needs || [];
  if (!needs.length) console.log('  needs: (none)');
  for (const n of needs) {
    console.log(`  need: ${n.dimension} = ${JSON.stringify(n.value)}  [${n.strength}${n.source ? ` · ${n.source}` : ''}]`);
  }
}

// Margaret's four needs (docs/DESIGN.md §3) with accurate provenance:
// captions/simplify are what the onboarding page's per-area defaults derive
// from ticking hearing + cognitive; readAloudRate/pacing can NOT come from
// the onboarding page today (it never parses free text) so they are seeded by
// the setup script and say so.
export const MARGARET_NEEDS = [
  { dimension: 'readAloudRate', value: 0.8, strength: 'preference', source: 'setup-script' },
  { dimension: 'pacing', value: 'stepwise', strength: 'preference', source: 'setup-script' },
  { dimension: 'simplify', value: true, strength: 'preference', source: 'onboarding-derived' },
  { dimension: 'captions', value: true, strength: 'preference', source: 'onboarding-derived' },
];

export const MARGARET_AREAS = ['hearing', 'cognitive'];

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}

export function flag(name) {
  return process.argv.includes(`--${name}`);
}
