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

| File | What it is | How portable |
|---|---|---|
| `xr-audio.ts` | The XR audio surface. Takes speaking rate, simplify and captions from the toolkit's `renderXRSettings`, and adds what audio needs: one-step-at-a-time pacing, pauses, utterance size, gist-first, pitch, volume. | High — pure, same shape as `xr.js` |
| `adapters/prompt-directives.ts` | Settings → the lines added to an LLM's prompt (one step at a time, plain words, short sentences, gist first, never talk down). | High — any app that speaks through a model |
| `adapters/paced-delivery.ts` | Settings → speech in short chunks with pauses between. The caller supplies the voice. | High — no engine, no device |
| `adapters/voice.ts` | Settings → one voice engine's options (ElevenLabs numbers; a Gemini style line). | Low — vendor glue, and it carries this demo's same-voice filming rule. May stay app-side for good. |

## What would go to the toolkit, in order

1. **Three words for the needs vocabulary** — `pacing` (`continuous` |
   `stepwise`), `voicePitch` (`low` | `standard`), `spokenDetail` (`gist` |
   `standard` | `full`). The toolkit stores them today but no surface of its
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
