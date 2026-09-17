# Audio-overlay demo videos — design

The XR-track demo videos, realized as an **audio overlay** on camera-equipped
MentraOS smartglasses. Two 2-minute films sharing one rig: an older adult uses
the same glasses assistant twice — once on generic defaults, once reading her
toolkit profile — and the difference is the whole story.

> **Rev 4 — targets the cleaned toolkit.** The toolkit is now the standalone
> `@ai4a11y/toolkit` package in the Collective's repo
> (`AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit`, checked out
> at `toolkitv2/AI-for-Accessibility-Toolkit/`; the earlier
> `anoopsinha/AI-for-Accessibility-Toolkit-Draft` fork this was designed
> against has been merged into it and is no longer used): core + catalog only, no
> bundled UI, with an *optional* onboarding service (`:4000/onboarding`) and an
> *optional* controller (`:4000/controller`). Per the repo's model, UI apps
> live in their **own repositories** (the `browser-harness-a11y` fork is the
> worked precedent) and either link the toolkit locally or call `server/`.
> This demo **links it locally**, and the ground rule is hard:
> **nothing in the toolkit changes.** Everything the demo needs works with the
> toolkit as-is (§7); toolkit-side wishes are collected separately in §7.4 as
> methodical follow-ups (the repo's `docs/FOLLOW-UPS.md` pattern) that never
> block filming. The demo app becomes its own repo, **`wearable-extension`**.

**Verdict: feasible, and most of the rig already runs.** The draft repo's
wearable surface (`AI-for-Accessibility-Toolkit-Draft/wearable/`) is a working
Mentra app: camera over RTMP → FrameStore → orchestrator → Gemini (request
engine) → `speak()` + HUD, with Mentra STT in, a skill registry
(`read-text-aloud`, `scene-describe`, …), a hardware-free rehearsal harness
(`bun run demo` — clip / webcam / glasses stream, boots paused so it never bills
until Start), and a deployed instance with a documented deploy flow. What it
lacks is exactly what this demo adds: it runs on a **draft-era profile**
(`wearable-profile.json` + a hand-rolled `read-aloud-preference.json`), not the
toolkit's AbilityModel, grants, or consent machinery. The build is therefore a
**swap, not a green-field app**: replace the draft profile with the real toolkit
core, add one skill per video.

---

## 1. What the camera changes

The previous revision of this design assumed audio-only glasses and chose the
appliance walkthrough because scenario 2 needed vision. With the camera (and
`read-text-aloud` already built):

- **Scenario 2 ("read what I'm looking at") is unblocked and nearly free** — the
  skill exists; its A/B is delivery-side (verbatim-fast vs. gist-first-slow).
- **Scenario 1 (appliance walkthrough) gets a wow beat**: the guide can visually
  *verify* a step — "I can see the dial is on Cottons. Good." — instead of
  trusting "done" alone.
- **Both videos share one rig**, so film both in one shoot.

**Recommendation: lead with video 1 (walkthrough)** — it exercises four profile
dimensions (rate, pacing, confirmation, plain language) where scenario 2 mostly
exercises one, and a machine physically starting is a stronger arc than a bill
being summarized. **Video 2 films the same afternoon** for close to zero extra
build (§8).

## 2. The one rule that makes the comparison honest

**One app, one model, filmed twice.** Baseline and toolkit takes are the *same*
glasses app, same voice, same task, same question — and the guidance itself is
**generated live by the same Gemini model in both takes**, from the same
hardcoded prompt + task brief (§5.2). The switch (`GUIDE_MODE=baseline`)
controls exactly **two injection points**:

- **Input** — toolkit mode appends a *profile block* to the prompt, derived from
  Margaret's granted AbilityModel ("one action at a time, then stop and wait";
  "short sentences, plain words"). Baseline sends the model the normal input.
- **Output** — toolkit mode renders the answer through
  `renderAudioSettings()` (0.8×, chunked, done-gated, captions). Baseline
  speaks the model's raw answer directly, at defaults.

So the film's claim sharpens: not "a scripted app behaves differently," but
**the same intelligent model, adapted by the toolkit on the way in and on the
way out — versus its own raw output.**

The baseline stays *functional*, not broken: it answers, and it repeats when
asked. Its failure is that repeating the same firehose doesn't help — the
problem is the shape of the delivery, not the volume of information. That keeps
the film a demonstration of adaptation, not a strawman.

One more constant: **the same `voice_id` in both takes**, even though the
profile could pick a calmer, lower voice (`voicePitch`, §7.2). If the toolkit
take also sounds like a different person, viewers attribute the win to a nicer
voice, not to adaptation. The A/B varies only rate, pacing, wording, and
captions.

## 3. Persona and profile

**Margaret, 74.** Hearing aids, doesn't like being rushed, new machine after
twenty years. Her profile starts in the cleaned repo's own onboarding service
(`node onboarding/server.js`, local mode): the setup shot films the actual
`:4000/onboarding` page as she ticks **hearing** and **cognitive** (the page
lists the raw area ids — there is no "Memory" label) and types "instructions
one step at a time please, not too fast."

**Provenance, stated plainly:** today's onboarding derives needs only from
fixed per-area defaults (`hearing → captions`, `cognitive → simplify +
reduceMotion`) and does **not** parse free text into needs — so `readAloudRate`
and `pacing`, the two dimensions the A/B rides on, never enter the store from
the page alone. The demo therefore runs a documented **seed step**
(`import-profile.mjs --seed`, §impl 3.7): before the blob export it writes the
full four-need array below via the toolkit's public `setProfileField` path
(replacing the derived array, dropping the stray `reduceMotion`), with sources
recorded accurately (`onboarding-derived` for captions/simplify, `setup-script`
for rate/pacing). The film's narration says "she set up her profile in the
toolkit" — true of the store, and this doc is the record of how each need got
there. "Onboarding captures rate/pacing itself" is filed as a follow-up
(§7.4), not smuggled into the shot.

```json
{
  "supportAreas": ["hearing", "cognitive"],
  "needs": [
    { "dimension": "readAloudRate", "value": 0.8,        "strength": "preference", "source": "onboarding" },
    { "dimension": "pacing",        "value": "stepwise",  "strength": "preference", "source": "onboarding" },
    { "dimension": "simplify",      "value": true,        "strength": "preference", "source": "onboarding" },
    { "dimension": "captions",      "value": true,        "strength": "preference", "source": "onboarding" }
  ]
}
```

On-screen profile card: **Margaret · Slower speech (0.8×) · One step at a time ·
Plain words · Captions on.** The `captions` need renders to the phone panel
(large text, the draft's `/webview`) and to the HUD when the glasses have one.

## 4. Shot-by-shot script — video 1

The glasses' lines below are the **target script**: the model generates its
wording live in every take (temperature low, same task brief), so rehearse
until the takes land close to these beats — the exact words may vary, the shape
must not. "Repeat" replays the transcript verbatim, never regenerates.

### 0:00–0:15 — Setup

| Time | See | Hear |
|---|---|---|
| 0:00 | Margaret puts on the glasses; phone in hand | Narrator: "Margaret's new washing machine arrived this week. Her glasses can help — two ways." |
| 0:08 | The toolkit's onboarding page (`:4000/onboarding`) — she ticks hearing + cognitive; then her profile card with all four chips | Narrator: "She set up her accessibility profile once, in the toolkit. Slower speech. One step at a time. Plain words." (§3 records how each need entered the store.) |

### 0:15–1:00 — Baseline (toolkit off) — *visible failure*

| Time | See | Hear |
|---|---|---|
| 0:15 | Margaret at the machine | Margaret: "How do I start a wash?" |
| 0:18 | Phone panel: generic "Speaking…" | Glasses, **1.0×, one paragraph**: "To begin a standard cycle, add detergent to compartment II of the dispenser drawer, set the program selector to Cottons, adjust the temperature to forty degrees using the temp key, then press and hold the Start/Pause key until the indicator illuminates." |
| 0:36 | She hesitates at the drawer — three compartments | Margaret: "Which one is compartment two? … Repeat, please." |
| 0:40 | — | Glasses: **the identical paragraph, same speed.** |
| 0:55 | Dial sits on Synthetics; she steps back | Margaret: "That's too fast for me." Freeze frame. Caption: **"Same information. Wrong shape."** |

### 1:00–1:45 — With the toolkit — *succeeding*

| Time | See | Hear |
|---|---|---|
| 1:00 | Phone panel mirrors the consent line | Glasses, **spoken consent** (the Consent port's `present`/`capture`, audio-first): "Appliance Guide would like to read your accessibility profile — needs and speech. Okay?" Margaret: "Yes." |
| 1:05 | — | Margaret: "How do I start a wash?" |
| 1:07 | Phone panel shows each line as large-text captions from here on | Glasses, **0.8×, warm**: "Sure. One step at a time. First: pull open the small drawer at the top left." |
| 1:13 | She opens it | Margaret: "Done." |
| 1:15 | — | "Good. Pour the soap into the biggest section, then push the drawer shut." — "Done." |
| 1:23 | — | "Now turn the big dial to Cottons." — "Done." |
| 1:29 | **Camera verification beat** — POV inset of what the glasses see | Glasses: "I can see it's on Cottons. Good." |
| 1:32 | — | "Press the temperature button until the screen shows forty." — "Done." |
| 1:38 | — | "Last one: hold the Start button down until it lights up." |
| 1:42 | **The machine starts.** She smiles | Glasses: "That's it — the wash is running." |

### 1:45–2:00 — Debrief

Split screen, baseline freeze left / running machine right. Three caption beats:

1. "Same assistant. Same task. Same camera."
2. "The difference: it read her toolkit profile — slower speech, one step at a
   time, plain words."
3. "Set up once. Works in any app that speaks toolkit." → collective end card.

**Optional +10s beat** (the toolkit's most distinctive property): after the wash
starts — Glasses: "You asked me to repeat earlier. Should I always go one step at
a time on new appliances?" → proposal card on the phone panel → Accept. Real
`importInsight` → consent-gated proposal: the system learns, never silently.

## 5. The rig

One pipeline, two injection points — baseline is the same picture with the two
`◆` toolkit edges absent:

```
 mic ─STT─► [ prompt: base + task brief ◆+ profile block ] ─► Gemini ─answer─► [ ◆delivery render ] ─► TTS ─► glasses
 camera ─frames───────────────────────────────────────────────► ▲                    │                        + captions
                                                                                     │ raw, 1.0× (baseline)   (toolkit)
        ◆ = toolkit injection                                                        ▼
   Toolkit (same Bun process): Librarian · Margaret's AbilityModel (file store)
     onboarded once at :4000/onboarding ─► import-profile.mjs
     requestGrant ─► spoken consent ─► exportAbilityModel ─► ◆ prompt block + ◆ renderAudioSettings
     repeat pattern ─► importInsight ─► consent proposal (never silent)
   panels: demo page + /webview ◄── captions · consent card · Done button · A/B toggle
```

- **Reused as-is from the old draft's wearable**: transport (`rtmp.ts`,
  `frames.ts`, `mentra-io.ts`), engines, orchestrator, webview panel, rehearsal
  harness, deploy flow. The request engine (not Live) stays the default —
  reliable on film day.
- **Toolkit linked locally, consumed as-is**:
  `"@ai4a11y/toolkit": "file:../AI-for-Accessibility-Toolkit/toolkit"`
  (relative to the app repo at `~/mas/accessibility_collective/toolkitv2/wearable-extension/`)
  — plain ESM, symlink-style install assumed. The app implements its four ports
  from the `toolkit/platforms/node/` templates (`fileKV(dir)` — the file-backed
  KV already exists there — pointed at the app data dir; `nodeClock` /
  `nodeScheduler` as-is; `Consent` implemented as the spoken
  `present`/`capture` flow).
- **Profile transfer respects single-writer stores**: the onboarding service
  and the glasses app each embed their own toolkit instance — they must never
  share a `DATA_DIR`. A ~20-line `import-profile.mjs` in the app opens the
  onboarding store read-only, calls `exportProfileBlob()` for Margaret's uid,
  and `importProfileBlob(blob)` into the app store — public API only, and it
  exercises the protocol-v1 blob path for real.
- **Replaced by the toolkit**: `wearable-profile.json` → the Librarian;
  `read-aloud-preference.json` hand-rolled learning → `importInsight` proposals;
  the `SPEECH_STYLE` env var → `render.language.simplify`. The draft's
  situational skills (watch-your-step, ping, …) stay off via `WEARABLE_SKILLS`
  to keep the film clean.
- **Speech knobs are real** (verified against the installed `@mentra/sdk`
  typings and current vendor docs): Mentra's `session.audio.speak(text,
  options)` takes a full `SpeakOptions` — it is **ElevenLabs under the hood**
  (`voice_settings.{speed, stability, style, similarity_boost,
  use_speaker_boost}`, `voice_id`, `model_id` default `eleven_flash_v2_5`,
  `volume` 0–1, track mixing). The draft's `mentra-io.ts` simply never passed
  the second argument — a one-line change. Full knob map in §5.1.
- **Runtime honesty — stronger than before**: STT, camera verification, TTS,
  and every adaptation run live; and the guidance itself is **generated by
  Gemini in both takes** from the same hardcoded prompt + task brief. Nothing
  spoken is pre-authored — the toolkit changes only what enters the prompt and
  how the answer is delivered. Margaret's own words (`freeText`) never reach
  the prompt: the profile block is built from the **granted** AbilityModel
  slice only. The webview panel's step controls remain the film-day safety net.

### 5.1 TTS engine knobs — what is actually adjustable

The adaptable surface splits into **three layers**, in order of reliability.
Profile-driven adaptation should map to layer 3 first (deterministic,
engine-free), layer 1 second (real parameters), layer 2 last (best-effort).

**Layer 1 — TTS parameters (deterministic).**

| Knob | ElevenLabs (= Mentra `speak()` on glasses) | Gemini TTS (demo-harness voice) |
|---|---|---|
| Rate | `voice_settings.speed` — 0.25–4.0 API range; keep to the 0.7–1.2 perceptual band | none — prompt only |
| Steadiness | `stability` 0–1 (higher = steadier, flatter — good for guide mode) | none — prompt only |
| Expressiveness | `style` 0–1 (keep 0: clearest, lowest latency) | none — prompt only |
| Voice identity / pitch | `voice_id` — pick from a low-pitch voice set (no numeric pitch param) | `voiceName` — ~30 prebuilt voices |
| Loudness | Mentra `volume` 0–1 (+ `use_speaker_boost`) | none — client-side gain |
| Model / latency | `model_id`: `eleven_flash_v2_5` (fast, the Mentra default) vs `multilingual_v2` (quality) vs `v3` (audio tags, no break tags) | TTS-capable Gemini models |
| Language | multilingual models + language | voice + prompt |

**Layer 2 — text/prompt level (best-effort).**
ElevenLabs: `<break time="0.9s"/>` pauses up to 3 s (not on v3; too many
destabilize a generation — prefer app-side silence), pronunciation dictionaries
(up to 3 — appliance/brand words), `apply_text_normalization`. Gemini TTS: the
whole control surface is a natural-language style instruction — pace, tone,
accent, emotion ("speak slowly and warmly, pause between sentences") — steerable
but not guaranteed.

**Layer 3 — app orchestration (deterministic, engine-independent).**
Chunking (one action per utterance), silence between `speak()` calls
(`pauseAfterUtteranceMs`), confirm gating, repeat behavior (re-say the current
step; on a second "repeat", drop `speed` another 0.1), an earcon before each
step (Mentra `playAudio` track mixing), captions mirror.

**Engine choice:** ElevenLabs is the adaptation engine — its knobs are
parameters, not suggestions, and the glasses already speak through it. Gemini
TTS stays what it is in the draft: the laptop voice for screen-share rehearsal
(`engine/tts.ts`), now given a style line derived from the same render.

### 5.2 The content lane — one model, one brief, two prompts

The guidance is not scripted; Gemini generates it each turn. What IS hardcoded
(identical in both takes, so the A/B stays fair):

- **Base prompt** — "You are a voice assistant on smart glasses helping with a
  household task. Guide the user."
- **Task brief** (`tasks/washing-machine.json`) — appliance *facts*, not
  wording: dial positions, the three drawer compartments and which one takes
  detergent, how the temperature button cycles, hold-Start-until-lit. Both
  modes read the same brief; the model formulates everything spoken.
- **Any other task** gets the same kind of brief written by the model
  (`src/skills/task-brief.ts`): one call from the request and the camera view,
  with no profile, mode or delivery directive in that prompt, reused for every
  take of that request — so both modes still read one identical brief. The
  two scripts stay as fixtures for the filmed tasks (verified facts, the dial
  check).

The only input-side difference is the **profile block** (toolkit mode only),
derived mechanically from the granted AbilityModel + render — e.g. *"give
exactly ONE action, then stop and wait for 'done' · sentences ≤ 18 words ·
plain words, no jargon · a warm short confirmation before each next step."*
Baseline gets no block and its raw answer goes straight to TTS. Determinism on
film day: temperature ≈ 0.2, the same brief every take, "repeat" replays the
transcript rather than regenerating, and the toolkit-side speaker still
enforces chunking/gating even if the model rambles.

Two truths the film must respect, not paper over:

- **The guaranteed contrast is delivery shape** (all-at-once vs. one gated step,
  1.0× vs. 0.8×, verbatim re-dump vs. paced repeat) — that is deterministic and
  app-measured. The *wording* contrast (manual register vs. plain words) is
  expected but not guaranteed: an unprompted model may produce decent steps on
  its own. To keep the baseline's register honest rather than staged, the
  **brief states facts in the manual's own terms** ("compartment II — largest,
  left"), so a raw answer naturally sounds like the manual while the profile
  block translates. The on-screen claims anchor to delivery.
- **Disclose the method**: the debrief (or description) states that both takes
  are the same model with the prompts published in the repo, and that takes
  were rehearsed; publish one uncut take alongside the edited film. A skeptical
  HCI audience should also not read the baseline as "what products ship" — the
  claim is *unadapted model* vs. *toolkit-adapted model*, not a product
  comparison.

## 6. Where the code lives

- **Demo app** → its own repository, **`wearable-extension`** (the cleaned repo's
  model: UI apps live outside the toolkit, like `browser-harness-a11y`), forked
  from the old draft's `wearable/`, linking the toolkit locally as a `file:`
  dependency.
- **The cleaned toolkit repo is not touched.** No new surface, no vocabulary
  edit, no host demo lands there as part of this work — §7.4 collects what we
  *propose* upstreaming afterward, methodically.
- Optional and out of the film's scope: the app could later implement the
  `ControlPort` (`controller/PROTOCOL.md`) so the experimental
  `:4000/controller` UI can drive the glasses over a websocket ("slower",
  "repeat"). Listed in §7.4, not built now.

## 7. App-side modules — the toolkit is consumed as-is

Everything the demo needs works against the toolkit's current public API; the
audio-specific pieces live in `wearable-extension`, not in `toolkit/`.

### 7.1 `wearable-extension/src/audio-render.js`

`renderAudioSettings(model)` — pure math over the AbilityModel, written in the
style of `toolkit/surfaces/xr.js` (~60 lines + in-app unit tests). XR's renderer
only carries `speech.rate` and `simplifyLanguage`; an audio-first surface needs
delivery *shape*. Consumers beyond glasses: phone voice assistants, smart
speakers — which is why it's a natural upstream PR once proven (§7.4).

Its input-side sibling is **`src/toolkit/prompt-block.js`** —
`profilePromptBlock(model, render)`, the pure function that turns the granted
AbilityModel into the §5.2 prompt block. Output render and input block are the
demo's two halves of "the toolkit adapts an intelligent model."

| Output | Derived from | Default |
|---|---|---|
| `speech.rate` | needs `readAloudRate` | 1.0 |
| `speech.pitchPreference` (`low`\|`standard`) | needs `voicePitch` | `standard` |
| `speech.expressiveness` (`steady`\|`natural`) | stepwise or `simplify` → `steady` | `natural` |
| `speech.volume` (0–1) | supportAreas includes `hearing` → 1.0 | 0.85 |
| `speech.pauseAfterUtteranceMs` | stepwise → 900 | 250 |
| `delivery.mode` (`continuous`\|`stepwise`) | needs `pacing` | `continuous` |
| `delivery.confirmToAdvance` | `pacing === 'stepwise'` | false |
| `delivery.maxWordsPerUtterance` | stepwise → ~18 | null |
| `delivery.gistFirst` | needs `spokenDetail === 'gist'`, else `simplify` | false |
| `language.{simplify, readingLevel, language}` | model top level + needs | pass-through |
| `captionsMirror` | needs `captions` | false |

The render stays **vendor-neutral**; a sibling module owns a tiny mapper, one
pure function per engine:

| renderAudioSettings | → ElevenLabs / Mentra `SpeakOptions` | → Gemini TTS |
|---|---|---|
| `speech.rate` 0.8 | `voice_settings.speed: 0.8` (clamped 0.7–1.2) | style line: "speak slowly" |
| `speech.expressiveness` `steady` | `stability: 0.75, style: 0` | style line: "calm, even tone" |
| `speech.pitchPreference` `low` | `voice_id` from a curated low-pitch set | deeper `voiceName` |
| `speech.volume` | `volume` (+ `use_speaker_boost: true`) | client-side gain |
| `delivery.*` | app orchestration (layer 3) — not TTS params | same |
| repeat, 2nd time | `speed − 0.1` for that utterance | style line: "slower this time" |

### 7.2 New needs dimensions — storable today, no toolkit change

The crucial fact: `normalizeNeed` (`toolkit/core/ability.js`) keeps **any**
dimension string, and web/XR renderers ignore dimensions they don't know. So all
three write cleanly via `setProfileField('fields.needs', …)` against the toolkit
as-is; *canonicalizing* them in the registry/vocabulary docs is the upstream
follow-up (§7.4), not a prerequisite.

- **`pacing`** (`'continuous' | 'stepwise'`) — video 1's core. Nothing in the
  current vocabulary says "one action at a time, wait for me." A web checkout
  wizard could honor it later.
- **`voicePitch`** (`'low' | 'standard'`) — presbycusis is high-frequency
  hearing loss, so a lower-pitched voice is genuinely easier for many older
  adults. Real knob on every engine (voice selection). Stored in her profile,
  **held out of the filmed A/B** (§2) — the wearable honors it outside the
  demo cut.
- **`spokenDetail`** (`'gist' | 'standard' | 'full'`) — video 2's dimension:
  how much of what's seen gets spoken, with detail on request. LLM-side, not a
  TTS knob. Subsumes the rev-2 open question; ArtInsight's "verbosity" is the
  same concept.

Explicitly **not** new dimensions (derived instead): stability/style
(← pacing/simplify), pauses (← pacing), volume (← `hearing` support area).
Voice *identity* (a preferred named voice) is a scoped setting
(`recordScopedSettings`), not an ability need.

### 7.3 The draft's learning loop, done properly

The draft already *learns* from the world — `read-text-aloud` measures how small
the text she asked about was (`sizePct`, `kind`) and writes a legibility
threshold to a JSON file, with a "copy it into the extension by hand" stub for
the web side. That whole path is what `requestGrant` / `importInsight` /
consent proposals exist for. The demo replaces the file with the real machinery,
and the old stub becomes the actual cross-surface story: the wearable teaches
the web extension her fine-print threshold **through the toolkit**, gated by her
consent. Insight kinds: video 1 — repeated-repeat → propose stepwise/slower
default; video 2 — measured legibility threshold → propose `read-aloud` scope.

### 7.4 Proposed toolkit follow-ups — separate, methodical, never blocking

Collected in the shape of the cleaned repo's `docs/FOLLOW-UPS.md` (its explicit
mechanism for deferred, scoped work), to be filed as entries/PRs against
`AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit` **after** the demo proves them.
Filming depends on none of these.

1. **`toolkit/surfaces/audio.js`** — upstream the proven `audio-render.js` as a
   first-class surface beside `web.js` / `xr.js`, with tests.
2. **Vocabulary canonicalization** — register `pacing`, `voicePitch`,
   `spokenDetail` in the registry/vocabulary docs so other hosts discover them.
3. **`toolkit/hosts/audio-demo/demo.js`** — the CI-runnable terminal proof
   (onboard → grant → render → insight back), a copy of `xr-demo`, ~1 hour.
4. **Onboarding needs-capture** — the onboarding page derives needs only from
   per-area defaults and never parses free text; capturing `readAloudRate` /
   `pacing` (and labeling areas beyond raw ids) would remove the demo's seed
   step. Until then the seed script is the documented interim.
5. **Package metadata gaps** — *mostly closed upstream by commit `a71b34a`*:
   `exports` now has `./platforms/node/kv.js` (the app imports `fileKV` by
   package name) and `files` covers `platforms/` and `registry/`. Still open:
   `files` omits `hosts/`, which `demo:xr` needs — fine for a symlinked
   `file:` install, breaks a pack-style install.
6. **Receiver task (their taxonomy):** `wearable-extension` implements the
   `ControlPort` so `:4000/controller` can drive the glasses remotely —
   optional, post-demo.

## 8. Video 2 — "read what I'm looking at" (same shoot)

Margaret holds a **prop** utility bill up. Baseline: `read-text-aloud` as it
exists — verbatim, fast, every line. Toolkit: the same skill styled by the
render — `gistFirst` + `readingLevel`: *"This bill says you owe forty dollars by
March third. Want the details?"* Detail only on request.

- Build cost ≈ ½ day: thread `renderAudioSettings` through the existing skill's
  prompt (the `speechStyle` hook already exists in `compose.ts`).
- Same timeline shape: setup 0:15 / baseline fails 0:45 / toolkit succeeds 0:45 /
  debrief 0:15.
- Debrief line: "and the assistant stores nothing from what it reads" — which
  is true because the app never calls `logObservation`. Do NOT credit the
  taxonomy's `finance` no-memory zone for this: zone assignment is web-domain
  based and nothing classifies a paper bill into it; wiring that up is a
  possible follow-up, not a claimable fact today.
- Optional payoff shot: the measured text size flows back as an insight (§7.3)
  and the *web extension* starts reading fine print for her — cross-surface, on
  camera.
- Props: fabricated bill only, never real mail.

## 9. Build and film plan — ≈6 build days; budget 8–9 wall-clock with rehearsal, filming, and slack

| # | Task | Size |
|---|---|---|
| 1 | Create the **`wearable-extension`** repo from the old draft's `wearable/`; strip situational skills; link `"@ai4a11y/toolkit": "file:…"`; run `npm test` + the toolkit's `demo:xr` once to pin the version | ½ day |
| 2 | Embed the toolkit (file-KV port from the `platforms/node` template, clock/scheduler, audio Consent `present`/`capture`); `GUIDE_MODE=baseline` switch; pass `SpeakOptions` through `mentra-io.ts` (one-line) | 1 day |
| 3 | `src/audio-render.js` + `prompt-block.js` + the render→SpeakOptions / Gemini-style mappers + in-app unit tests | ½ day |
| 4 | `task-guide` skill: guide policy over the request engine (task brief in, one-step turns, "done"/"repeat", transcript-replay repeat), one vision verification on the dial step | 1 day |
| 5 | Onboard Margaret at `:4000/onboarding` (local mode); `import-profile.mjs --seed` (seed the full needs — §3 — then exportProfileBlob → importProfileBlob); `reset-take.mjs` (wipe + re-import between takes) | ½ day |
| 6 | Video 2: thread the render through `read-text-aloud` (gist-first + readingLevel) | ½ day |
| 7 | Rehearse both scripts hardware-free (`bun run demo`, webcam) | ½ day |
| 8 | On-glasses dry run: RTMP reachability, STT of "done", TTS voice, consent flow | ½ day |
| 9 | Film both videos + debrief shots | 1 day |

Risks → mitigations:

- *RTMP / cloud reachability on film day* — MentraOS needs a reachable server:
  use the existing deployed instance (or ngrok static URL) + a phone hotspot;
  request engine, not Live.
- *Vision verification latency or a miss* — verify only the dial step; "done"
  always advances regardless; the beat degrades to silence, never to a block.
- *"Done" unrecognized* — Mentra STT is the proven path; fallback: advance
  button on the phone panel (good multimodal practice anyway).
- *TTS latency creeping up* — keep `eleven_flash_v2_5` and `style: 0` (any
  style > 0 adds latency); pauses come from app-side silence, not `<break>`
  tags (which destabilize when overused).
- *Gemini nondeterminism (now generating the guidance)* — same task brief both
  takes, temperature ≈ 0.2, "repeat" replays the transcript verbatim, the
  speaker's chunk/gate guardrails cap a rambling answer in toolkit mode, and
  the §4 script is the rehearsal target, not a playback file.
- *Participant* — real older adult with signed media consent (or a colleague's
  parent / actor for the public cut); over-shoulder framing if a face shouldn't
  appear. POV insets come free from the FrameStore.
- *Two processes, one store* — the onboarding service and the app each embed
  their own toolkit over their own `DATA_DIR`; stores are single-writer, so
  never share one. The blob script is the only transfer path.
- *Retakes vs. the consent machinery* — grant requests and insights are
  proposals with dedup, decline cooldowns, and a **default cap of 3 proposals
  per week**; a granted app returns `already-granted`. Every toolkit-mode
  retake of the consent or insight beat therefore starts from
  `reset-take.mjs` (wipe `APP_DATA_DIR`, re-import the blob). For long
  rehearsal sessions, booting with the toolkit's `demo` port on lifts the
  weekly cap — use it in rehearsal only, never in the filmed take.
- *Toolkit drift while we build* — the `file:` link tracks the checkout; pin a
  commit of the cleaned repo for the build window and note it in
  `wearable-extension`'s README.
