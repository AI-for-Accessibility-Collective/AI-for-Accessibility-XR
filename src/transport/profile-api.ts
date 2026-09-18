// The profile editor's server side, shared by both web surfaces: the
// standalone demo (demo-server.ts, Bun.serve) and the phone bridge's panel
// (webview.ts, Express) each mount these three handlers under their own
// prefix and only translate request/response.
//
//   GET  …/profile         the profile as the editor shows it
//   POST …/profile         {key, value} — one need; value null clears it
//   POST …/profile/reset   back to Margaret's fixture profile
//
// Every change is written through host.ts (the one file that talks to the
// toolkit) and then handed to the live session, so a take in toolkit mode
// adapts from its next turn. The answer to every write is the fresh profile,
// which is what the panel re-renders from — no client-side guessing.

import type { AbilityModel } from '@ai4a11y/toolkit';
import { readModel, resetProfile, writeNeed, type GuideToolkit } from '../toolkit/host.ts';
import { checkNeedValue, NEED_SPECS } from '../toolkit/needs-catalog.ts';
import type { ProfileView, ProfileNeedView, ProfileAvailableView } from './phone-protocol.ts';
import type { SessionState } from '../runtime/session.ts';
import { renderXRAudioSettings } from '../toolkit-candidates/xr-audio.ts';
import margaret from '../../test/fixtures/margaret.blob.json';

export type { ProfileView, ProfileNeedView, ProfileAvailableView } from './phone-protocol.ts';

// The XR audio surface, read back as plain lines a person can check — one
// line per behaviour the prompt directives or the delivery switch on, so the
// panels can show exactly what a setting changes.
export function effectLines(model: AbilityModel | null): string[] {
  const r = renderXRAudioSettings(model);
  const lines: string[] = [];
  lines.push(r.delivery.mode === 'stepwise' ? 'One step at a time, then waits for you' : 'Whole answer at once');
  lines.push(r.speech.rate === 1 ? 'Normal speed' : `Speaks at ${r.speech.rate}× speed`);
  if (r.language.sentenceWords != null) lines.push(`Short sentences (about ${r.language.sentenceWords} words)`);
  if (r.language.clarity !== 'standard') {
    lines.push('Says what to do first, then where');
    lines.push('One new thing per sentence');
    lines.push('Asks a question instead of "if…"');
  }
  if (r.language.clarity === 'clearest') lines.push('Says which step you are on');
  if (r.language.simplify) {
    lines.push('Plain everyday words, never jargon');
    lines.push('The same word for the same thing');
  }
  if (r.delivery.gistFirst) lines.push('Gist first, details on request');
  if (r.captionsMirror) lines.push('Captions on the display');
  if (r.speech.pitchPreference === 'low') lines.push('Lower-pitched voice');
  return lines;
}

// The lines one need is responsible for: what disappears when it is removed.
function effectOf(model: AbilityModel | null, dimension: string): string[] {
  if (!model) return [];
  const without: AbilityModel = { ...model, needs: (model.needs ?? []).filter((n) => n.dimension !== dimension) };
  const rest = new Set(effectLines(without));
  return effectLines(model).filter((l) => !rest.has(l));
}

export interface ProfileApiDeps {
  // The live store handle — null until there is one (the glasses app opens
  // the store per phone session).
  toolkit: () => GuideToolkit | null;
  sessionState: () => SessionState;
  // Tell the session the store changed. Optional: a host with no live
  // session yet has nothing to refresh.
  onProfileChanged?: () => void | Promise<void>;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface ProfileApi {
  get(): Promise<ApiResult>;
  set(body: unknown): Promise<ApiResult>;
  reset(): Promise<ApiResult>;
}

function toView(model: AbilityModel | null, state: SessionState): ProfileView {
  const needs = model?.needs ?? [];
  const set = new Set(needs.map((n) => n.dimension));
  const rows: ProfileNeedView[] = [];
  // Catalog order first, so the card reads the same every take…
  for (const spec of NEED_SPECS) {
    const n = needs.find((x) => x.dimension === spec.key);
    if (!n) continue;
    rows.push({
      key: spec.key,
      label: spec.label,
      help: spec.help,
      kind: spec.kind,
      value: n.value,
      options: spec.options,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      unit: spec.unit,
      strength: n.strength,
      source: n.source,
      effect: effectOf(model, spec.key),
    });
  }
  // …then anything else the store holds, unhidden.
  for (const n of needs) {
    if (NEED_SPECS.some((s) => s.key === n.dimension)) continue;
    rows.push({ key: n.dimension, label: n.dimension, help: 'Stored in the profile; this guide has no control for it.', kind: 'other', value: n.value, strength: n.strength, source: n.source });
  }
  const available: ProfileAvailableView[] = NEED_SPECS.filter((s) => !set.has(s.key)).map((s) => ({
    key: s.key,
    label: s.label,
    help: s.help,
    kind: s.kind,
    default: s.default,
    options: s.options,
    min: s.min,
    max: s.max,
    step: s.step,
    unit: s.unit,
  }));
  return {
    mode: state.mode,
    profileOn: state.mode === 'toolkit' && state.profileOn,
    supportAreas: model?.supportAreas ?? [],
    needs: rows,
    available,
    effect: effectLines(model),
  };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export function createProfileApi(deps: ProfileApiDeps): ProfileApi {
  const noStore: ApiResult = { status: 409, body: { error: 'No profile store yet — connect the phone app first.' } };

  async function view(model: AbilityModel | null): Promise<ApiResult> {
    return { status: 200, body: toView(model, deps.sessionState()) };
  }

  // The session refresh runs after the write and before the answer, so the
  // profileOn/mode the panel gets back already reflect the new profile.
  async function changed(model: AbilityModel | null): Promise<ApiResult> {
    try {
      await deps.onProfileChanged?.();
    } catch (e) {
      console.error(`[profile] session refresh failed: ${errorText(e)}`);
    }
    return view(model);
  }

  return {
    async get() {
      const tk = deps.toolkit();
      if (!tk) return noStore;
      try {
        return await view(await readModel(tk));
      } catch (e) {
        return { status: 500, body: { error: `Could not read the profile: ${errorText(e)}` } };
      }
    },

    async set(body) {
      const tk = deps.toolkit();
      if (!tk) return noStore;
      const b = (body && typeof body === 'object' ? body : {}) as { key?: unknown; value?: unknown };
      if (typeof b.key !== 'string' || !b.key) return { status: 400, body: { error: 'key is required' } };
      let value: boolean | string | number | null;
      if (b.value === null || b.value === undefined) {
        // Clearing is allowed for anything in the store, catalog or not.
        value = null;
      } else {
        const check = checkNeedValue(b.key, b.value);
        if (!check.ok) return { status: 400, body: { error: check.reason } };
        value = check.value;
      }
      try {
        return await changed(await writeNeed(tk, b.key, value));
      } catch (e) {
        return { status: 500, body: { error: `Could not save: ${errorText(e)}` } };
      }
    },

    async reset() {
      const tk = deps.toolkit();
      if (!tk) return noStore;
      try {
        return await changed(await resetProfile(tk, margaret));
      } catch (e) {
        return { status: 500, body: { error: `Could not reset: ${errorText(e)}` } };
      }
    },
  };
}
