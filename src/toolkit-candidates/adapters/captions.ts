// Captions adapter — carries out `captions`: the guide's words are mirrored
// as text. The mirroring itself is done by whichever display the host has
// (HUD, panel); this only names it.

import type { XRAudioSettings } from '../xr-audio.ts';

export function effect(r: XRAudioSettings): string[] {
  return r.captionsMirror ? ['Captions on the display'] : [];
}
