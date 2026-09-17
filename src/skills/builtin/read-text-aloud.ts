// Read-text-aloud: read what the camera sees on request ("what does this
// say?"). Video 2's skill (docs/DESIGN.md §8).
//
// Trimmed on copy from the parts bin: the proactive auto-read monitor (lux
// gate) and the learnFromRead preference-file writes are gone — learning
// belongs to the toolkit's consent machinery now. What remains is the
// on-request read: readVisibleText() returns the verbatim text plus how
// small it looked (sizePct) and what kind of thing it was. The session
// speaks it verbatim in baseline; in toolkit mode the profile block +
// render turn it into gist-first delivery.

import type { GuideSkill } from '../types.ts';
import type { FrameEntry } from '../../transport/frames.ts';
import type { VisionClient } from '../../engine/vision.ts';

export const readTextAloud: GuideSkill = {
  meta: {
    id: 'read-text-aloud',
    name: 'Read Text Aloud',
    description: 'Reads text the camera sees — letters, labels, bills, menus — aloud on request.',
    supportAreas: ['vision', 'reading'],
    icon: 'volume_up',
  },
  promptBlock:
    'READ TEXT: When the user asks you to read something or what something ' +
    'says, read the visible text from the camera view accurately. If it is ' +
    'too blurry or out of frame to read reliably, say so and ask the user to ' +
    'hold steady or move closer. Do not guess at words you cannot make out.',
};

// True when the utterance asks to read what the camera sees: "read this",
// "can you read my bill?", "what does this letter say?", "what's written
// here". The session checks this before task triggers, so holding up a bill
// and asking about it reads the page rather than starting the bill task.
export function isReadRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  return (
    /\bread\b[^.?!]*\b(?:this|that|it|the|my|what)\b/.test(t) ||
    /\bwhat does\b[^.?!]{0,30}\bsay\b/.test(t) ||
    /\bwhat(?:'s| is) (?:written|printed)\b/.test(t)
  );
}

export const READ_KINDS = [
  'label', 'warning', 'instructions', 'document', 'receipt', 'sign', 'price', 'bill', 'letter', 'other',
] as const;

export interface ReadVisibleTextResult {
  // The verbatim visible text the wearer is showing.
  text: string;
  // Apparent character height as a percent of the frame height (1–40).
  sizePct: number;
  // Coarse content kind, one of READ_KINDS.
  kind: string;
}

// On-request "read this": one vision call that BOTH reads the text the wearer
// is showing AND reports how small it is + what kind of thing it is.
// Returns null when there's nothing readable.
export async function readVisibleText(
  { frames, vision }: { frames: FrameEntry[]; vision: VisionClient },
): Promise<ReadVisibleTextResult | null> {
  if (!frames.length) return null;

  const out = await vision.generate({
    systemInstruction:
      'You help a person read text they hold up to a wearable camera. These frames ' +
      'were captured at the moment the user asked for help, in order (most recent ' +
      'last). If the user is POINTING AT or HOLDING UP something, that is the ' +
      'priority — read THAT specific thing, not other text in the background. Treat ' +
      'the most recent frame as the key moment; use the others only to disambiguate. ' +
      'Find the main text the user is showing — a letter, bill, label, sign, menu, ' +
      'document, receipt, package, or screen — and read it verbatim. Also judge how ' +
      'SMALL the characters are (their apparent height as a percent of the frame ' +
      'height) and what KIND of thing it is. ' +
      'Respond with ONLY compact JSON, no prose and no code fences: ' +
      '{"text": "<verbatim text>", "sizePct": <integer 1-40>, "kind": ' +
      '"<one of label|warning|instructions|document|receipt|sign|price|bill|letter|other>"}. ' +
      'If there is no readable text the user is showing, respond exactly: NONE.',
    frames,
    text: 'Read the text the user is pointing at or showing and return the JSON described, or NONE.',
    // A runaway guard, not a length limit: a full-page letter transcribed as
    // JSON plus thought tokens must fit, or the JSON truncates and the read
    // is reported as illegible.
    maxOutputTokens: 4096,
    temperature: 0,
  });

  const t = out.trim();
  if (!t || /^none\b/i.test(t)) return null;
  return parseReadResult(t);
}

// Tolerate stray prose / code fences: pull the first {...} block and validate.
export function parseReadResult(raw: string): ReadVisibleTextResult | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (!text) return null;
    const rawPct = typeof obj.sizePct === 'number' ? obj.sizePct : parseInt(String(obj.sizePct), 10);
    const sizePct = Number.isFinite(rawPct) ? Math.max(1, Math.min(40, Math.round(rawPct))) : 6;
    const kind =
      typeof obj.kind === 'string' && (READ_KINDS as readonly string[]).includes(obj.kind)
        ? obj.kind
        : 'other';
    return { text, sizePct, kind };
  } catch {
    return null;
  }
}
