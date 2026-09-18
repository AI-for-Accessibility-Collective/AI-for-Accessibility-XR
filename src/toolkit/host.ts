// bootToolkit / readModel / writeNeed / resetProfile — the app's whole
// surface onto the AI for Accessibility Toolkit (docs/PLAN.md §3.1).
//
// The toolkit is consumed AS-IS from the linked sibling checkout of
// github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit:
// public API only, and only through this file. The node file store
// (`fileKV`) is the package's own, from its `platforms/node/kv.js` subpath.

import { createToolkit, validateProfileBlob, type Librarian, type Datastore, type AbilityModel, type Need, type ProfileBlob } from '@ai4a11y/toolkit';
import { fileKV } from '@ai4a11y/toolkit/platforms/node/kv.js';

// Where a need written from the profile editor says it came from — shown as
// provenance next to the onboarding's own sources.
export const EDITOR_SOURCE = 'profile-editor';

export interface GuideToolkit {
  librarian: Librarian;
  datastore: Datastore;
}

export async function bootToolkit(opts: {
  dataDir: string; // APP_DATA_DIR — NEVER the onboarding service's DATA_DIR (single-writer stores)
  actingUser?: string; // whose partition the glasses read (default 'margaret')
}): Promise<GuideToolkit> {
  const { librarian, datastore } = createToolkit({
    kv: fileKV(opts.dataDir),
    clock: { now: () => Date.now() },
  });
  await datastore.runMigrations();
  await librarian.setActingUser(opts.actingUser ?? 'margaret');
  return { librarian, datastore };
}

// The person's profile, read the way the toolkit documents for an embedded
// host: librarian.getAbilityModel(). Only the structured fields the app uses
// are passed on — the person's free text and the confidence score stop here,
// so neither can reach the model prompt or a panel. null when the store holds
// no profile; the caller then falls back to defaults (which IS baseline
// behavior).
export async function readModel(tk: GuideToolkit): Promise<AbilityModel | null> {
  const full = await tk.librarian.getAbilityModel();
  const needs = Array.isArray(full.needs) ? full.needs.map((n) => ({ ...n })) : [];
  const supportAreas = Array.isArray(full.supportAreas) ? full.supportAreas.map(String) : [];
  const readingLevel = full.readingLevel ?? null;
  const language = full.language || 'standard';
  if (!needs.length && !supportAreas.length && readingLevel == null && language === 'standard') return null;
  return { schemaVersion: full.schemaVersion ?? 1, supportAreas, readingLevel, language, needs };
}

// Every profile write goes through one queue per store handle: needs live as
// ONE array under `fields.needs`, so each write is read-modify-write on the
// same record, and two slider moves in flight together would otherwise let
// the second read the state before the first landed.
const writeQueues = new WeakMap<GuideToolkit, Promise<unknown>>();
function serialized<T>(tk: GuideToolkit, work: () => Promise<T>): Promise<T> {
  const next = (writeQueues.get(tk) ?? Promise.resolve()).then(work, work);
  writeQueues.set(tk, next.catch(() => {}));
  return next;
}

// Set one need (or clear it with value null), the way the toolkit documents
// for a user-initiated edit: librarian.setProfileField('fields.needs', …),
// which bypasses the proposal/consent gate by design — that gate is for
// INFERRED changes, and this is the person (or the presenter) saying so
// (toolkit API.md, "profile/ability"). The rest of the array is kept as is,
// so provenance on untouched needs survives; the written need is recorded as
// a preference from the editor. Values are the caller's business to validate
// (needs-catalog.ts) — this only writes.
export async function writeNeed(
  tk: GuideToolkit,
  dimension: string,
  value: boolean | string | number | null,
): Promise<AbilityModel | null> {
  return serialized(tk, async () => {
    const full = await tk.librarian.getAbilityModel();
    const kept: Need[] = (Array.isArray(full.needs) ? full.needs : []).filter((n) => n.dimension !== dimension);
    const needs: Need[] = value == null ? kept : [...kept, { dimension, value, strength: 'preference', source: EDITOR_SOURCE }];
    await tk.librarian.setProfileField('fields.needs', needs);
    return readModel(tk);
  });
}

// Back to a known profile: the same importProfileBlob the setup script uses
// (scripts/import-profile.mjs --fixture), re-stamped to now. The toolkit's
// import is last-write-wins on the blob's exportedAt against the local
// profile's updatedAt, so once anything has been edited here the fixture's
// fixed 2025 stamp would be refused as 'older-or-equal'; adopting the current
// clock is what makes "reset" mean "overwrite".
export async function resetProfile(tk: GuideToolkit, blob: unknown): Promise<AbilityModel | null> {
  return serialized(tk, async () => {
    if (!validateProfileBlob(blob)) throw new Error('profile blob failed validateProfileBlob');
    // Strictly after the local profile's last write: an edit and a reset in
    // the same millisecond must not tie (a tie is 'older-or-equal').
    const local = await tk.librarian.getProfile();
    const exportedAt = Math.max(Date.now(), (local?.updatedAt ?? 0) + 1);
    const stamped: ProfileBlob = { ...(blob as ProfileBlob), exportedAt };
    const res = await tk.librarian.importProfileBlob(stamped);
    if (!res.ok || !res.merged) throw new Error(`importProfileBlob refused the reset: ${res.reason ?? 'not merged'}`);
    return readModel(tk);
  });
}
