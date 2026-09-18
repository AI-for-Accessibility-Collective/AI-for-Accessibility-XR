# toolkit-candidates

Code written here first, meant to move into the AI for Accessibility Toolkit
once this demo has proven it — so that other wearable apps, not just this
task guide, can use it.

**The one rule:** files in this folder import the toolkit and each other,
never the rest of the app. The app imports from here. That keeps a later move
a copy, not a rewrite (`test/toolkit-candidates.test.ts` enforces it).

## The toolkit's three layers, for a wearable

| Layer | What it does | Web | Wearable |
|---|---|---|---|
| Profile | what the person needs | toolkit | toolkit |
| Surface | turns needs into settings for one medium — decides, does nothing | toolkit `surfaces/web.js` | toolkit `surfaces/xr.js` **+ `xr-audio.ts`** |
| Adapters | each carries out one kind of setting | toolkit `tools/adapters/` (web pages only) | **`adapters/`** |

## What is here

One adapter per adaptation, the toolkit's rule. Each carries the prompt lines
and/or delivery behaviour for one ability, the research behind each line as a
comment beside it, and its own plain-words description (what the panels show
under "What the guide will do").

| File | Ability | What it carries out | How portable |
|---|---|---|---|
| `xr-audio.ts` | all | The XR audio surface: takes rate, simplify and captions from the toolkit's `renderXRSettings`, adds pacing, clarity, gist-first, pitch, volume. Decides; does nothing. | High — pure, same shape as `xr.js` |
| `adapters/one-step.ts` | `pacing` | One action, then wait (prompt); short chunks with pauses (delivery, via `paced-delivery.ts`) | High |
| `adapters/action-first.ts` | `clarity` | Verb first, one new thing per sentence, a question instead of "if", the sentence cap; at the top level the step number (prompt) | High |
| `adapters/plain-words.ts` | `simplify` | Everyday words, one name per object (prompt) | High |
| `adapters/gist-first.ts` | `spokenDetail` | The gist first, one orienting sentence (prompt) | High |
| `adapters/captions.ts` | `captions` | Names the mirror; the host's display does it | Trivial |
| `adapters/voice.ts` | `readAloudRate`, `voicePitch`, hearing → volume | One voice engine's options (ElevenLabs numbers; a Gemini style line) | Low — vendor glue, and it carries this demo's same-voice filming rule |
| `adapters/paced-delivery.ts` | — | Engine-agnostic helper: chunk text, speak with pauses, stop on cancel | High |
| `adapters/prompt-directives.ts` | — | Joins the adapters' prompt lines into the one block, plus the always-on "speak as to a capable adult" guard (a rule, not an adaptation) | High |
| `effect.ts` | — | Joins the adapters' descriptions | High |

## What would go to the toolkit, in order

1. **Four words for the needs vocabulary** — `pacing` (`continuous` |
   `stepwise`), `voicePitch` (`low` | `standard`), `spokenDetail` (`gist` |
   `standard` | `full`), `clarity` (`standard` | `clear` | `clearest`: how
   each step is phrased — action first, one new thing per sentence, a
   question instead of a condition; the evidence is in
   `docs/design/working-memory-fit.md`). The toolkit stores them today but no surface of its
   own reads them. This matters most: a shared word is what lets a second app
   read the same profile.
2. **The surface** — `xr-audio.ts` as `toolkit/surfaces/xr-audio.js`, or folded
   into `xr.js`, or renamed `audio.js` (nothing in it is XR-only). The
   maintainers' call.
3. **The adapters** — an open question for the toolkit: its adapter catalog is
   web-only today, and for mobile and XR the app applies the settings itself.
   These files are the concrete case for deciding where non-web adapters live.

Deliberately absent: an adapter interface, a registry, enable/disable. With one
app using these, a shared shape would be a guess.
