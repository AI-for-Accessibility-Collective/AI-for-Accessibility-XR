// The needs the profile editor can set — the vocabulary the XR audio surface
// reads (toolkit-candidates/xr-audio.ts), one entry per dimension, with the
// plain-language label and the one-line explanation the panels show.
//
// Pure data + one validator; nothing here talks to the toolkit. The catalog
// is deliberately the only place that knows which value each dimension takes,
// so a write can be refused BEFORE it reaches the store: the surface narrows
// every value it reads, and a typo'd string stored under `pacing` would just
// silently render as 'continuous'.

import type { NeedKind } from '../transport/phone-protocol.ts';
export type { NeedKind };

export interface NeedSpec {
  key: string;
  label: string;
  help: string;
  kind: NeedKind;
  // choice
  options?: Array<{ value: string; label: string }>;
  // range
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  // What the surface assumes when the need is unset — the value an "Add"
  // starts from, so adding a need never changes delivery by itself.
  default: boolean | string | number;
}

// Order is display order: what the film is about first (pacing, rate, plain
// words, captions), then the two the toolkit stores but no surface of its own
// reads yet.
export const NEED_SPECS: readonly NeedSpec[] = [
  {
    key: 'pacing',
    label: 'Pacing',
    help: 'One step at a time: the guide gives one action, then waits until you say it is done.',
    kind: 'choice',
    options: [
      { value: 'continuous', label: 'All at once' },
      { value: 'stepwise', label: 'One step at a time' },
    ],
    default: 'continuous',
  },
  {
    key: 'readAloudRate',
    label: 'Speaking rate',
    help: 'How fast the guide talks. 1.0× is the normal speed; below it, the phrasing turns calm and unhurried too.',
    kind: 'range',
    min: 0.7,
    max: 1.2,
    step: 0.1,
    unit: '×',
    default: 1.0,
  },
  {
    key: 'simplify',
    label: 'Plain words',
    help: 'Everyday words and short sentences — "soap", "big dial" — not manual terms, never jargon, never technical terms.',
    kind: 'toggle',
    default: false,
  },
  {
    key: 'captions',
    label: 'Captions',
    help: 'What the guide says also appears as text on the display.',
    kind: 'toggle',
    default: false,
  },
  {
    key: 'spokenDetail',
    label: 'Detail',
    help: 'Gist first: the one-sentence point, then details only if you ask.',
    kind: 'choice',
    options: [
      { value: 'gist', label: 'Gist first' },
      { value: 'standard', label: 'Standard' },
      { value: 'full', label: 'Full detail' },
    ],
    default: 'standard',
  },
  {
    key: 'voicePitch',
    label: 'Voice pitch',
    help: 'Prefer a lower-pitched voice. Film mode keeps one voice for both takes, so on film this changes nothing.',
    kind: 'choice',
    options: [
      { value: 'standard', label: 'Standard' },
      { value: 'low', label: 'Low' },
    ],
    default: 'standard',
  },
];

export function needSpec(key: string): NeedSpec | undefined {
  return NEED_SPECS.find((s) => s.key === key);
}

export type NeedValueCheck = { ok: true; value: boolean | string | number } | { ok: false; reason: string };

// A value the editor sent → the exact value the surface expects, or why not.
// Numbers are snapped to the slider's step so 0.8000000001 never lands in
// the store; a string "0.8" from a form is accepted the same way.
export function checkNeedValue(key: string, value: unknown): NeedValueCheck {
  const spec = needSpec(key);
  if (!spec) return { ok: false, reason: `unknown need "${key}"` };
  switch (spec.kind) {
    case 'toggle':
      if (typeof value !== 'boolean') return { ok: false, reason: `${spec.label} is on or off` };
      return { ok: true, value };
    case 'choice': {
      const allowed = (spec.options ?? []).map((o) => o.value);
      if (typeof value !== 'string' || !allowed.includes(value)) {
        return { ok: false, reason: `${spec.label} must be one of ${allowed.join(', ')}` };
      }
      return { ok: true, value };
    }
    case 'range': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      const { min = -Infinity, max = Infinity, step = 0 } = spec;
      if (!Number.isFinite(n) || n < min - 1e-9 || n > max + 1e-9) {
        return { ok: false, reason: `${spec.label} must be a number from ${min} to ${max}` };
      }
      const snapped = step > 0 ? Math.round((n - min) / step) * step + min : n;
      return { ok: true, value: Math.round(snapped * 1000) / 1000 };
    }
  }
}
