#!/usr/bin/env bun
// The retake button (docs/PLAN.md §3.7). Grants and insights are consent
// proposals with dedup, decline cooldowns, and a default 3-per-week cap; a
// minted grant returns already-granted on the next ask. So the consent and
// insight beats are only re-filmable from a fresh store: this wipes
// APP_DATA_DIR and re-imports the fixture blob (~10 s), returning the store
// to the pre-consent state.
//
//   bun run reset:take            # ./data, margaret, checked-in fixture
//   bun scripts/reset-take.mjs --to ./data --uid margaret

import { rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { arg, assertDeletablePath, bootAppStore, importBlob, printModel } from './lib.mjs';

const uid = arg('uid', 'margaret');
const to = arg('to', process.env.APP_DATA_DIR || './data');
const fixturePath = arg('fixture', new URL('../test/fixtures/margaret.blob.json', import.meta.url).pathname);

const target = assertDeletablePath(to);
await rm(target, { recursive: true, force: true });
console.log(`[reset-take] wiped ${target}`);

const blob = JSON.parse(await readFile(fixturePath, 'utf8'));
const app = await bootAppStore(to, uid);
const model = await importBlob(app.librarian, blob);
printModel(model, `[reset-take] fresh store (${to}) uid=${uid}:`);
console.log('\n[reset-take] ✓ pre-consent state restored — no grants, no proposals, profile in place');
