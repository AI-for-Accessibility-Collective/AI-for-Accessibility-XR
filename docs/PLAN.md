# wearable-extension — implementation plan

The build plan for the demo app behind the two films in
[audio-demo-video.md](./audio-demo-video.md). This doc moves into the new repo
as `docs/PLAN.md` when it's created.

**Four ground rules**

1. **Clean repo.** `wearable-extension` starts empty; a file lands only when a
   phase needs it. The old draft's `wearable/`
   (`~/mas/accessibility_collective/AI-for-Accessibility-Toolkit-Draft/wearable/`)
   is a **parts bin we copy from**, never a fork we prune — no dead skills, no
   draft-era profile code, no live-engine machinery ever enters the tree.
2. **Toolkit consumed as-is.** `"@ai4a11y/toolkit": "file:../AI-for-Accessibility-Toolkit/toolkit"`
   (a checkout of `AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit`)
   — public API only; pin that repo's commit for the build window. Wishes
   go to the follow-ups list, never into the toolkit.
3. **The demo surface is load-bearing.** The old draft's browser demo
   (source picker: recorded clip / webcam / glasses stream; boots paused so it
   never bills; laptop TTS) is kept and becomes the primary dev + rehearsal
   rig: by Phase 3 both films are runnable end-to-end in a browser.
4. **The content is generated, not scripted.** Gemini produces the guidance
   live in BOTH modes from the same hardcoded base prompt + task brief. The
   toolkit's whole contribution is two injection points: the **profile block**
   added to the model's input, and the **delivery render** applied to the
   model's output. Baseline = the same model, raw, at defaults.

Repo location: `~/mas/accessibility_collective/toolkitv2/wearable-extension/`.

## 0. System at a glance

```
 mic ─STT─► [ prompt: base + task brief ◆+ profile block ] ─► Gemini ─answer─► [ ◆delivery render ] ─► TTS ─► glasses
 camera ─frames───────────────────────────────────────────────► ▲                    │                        + captions
                                                                                     │ raw, 1.0× (baseline)   (toolkit)
        ◆ = toolkit injection (absent in baseline)                                   ▼
   Toolkit (same Bun process): Librarian · Margaret's AbilityModel (file store, APP_DATA_DIR)
     onboarded once at :4000/onboarding ─► scripts/import-profile.mjs (blob transfer)
     requestGrant ─► spoken consent ─► exportAbilityModel ─► ◆ prompt-block + ◆ audio-render
     repeat pattern ─► importInsight ─► consent proposal (never silent)
   panels: demo page + /webview ◄── captions · consent card · Done button · A/B toggle
```

## 1. Target layout

```
wearable-extension/
├── package.json            bun · file: dep on @ai4a11y/toolkit · scripts: start/dev/demo/test/typecheck
├── .env.example            see §6
├── app_config.json         Mentra dev-console manifest (copied, skills options trimmed)
├── README.md               run it in 3 commands; pin note for the toolkit commit
├── docs/PLAN.md            this file · docs/DESIGN.md ← audio-demo-video.md
├── src/
│   ├── index.ts            Mentra entry: session wiring only (trimmed from old 464-line index)
│   ├── config.ts           env parsing (trimmed)
│   ├── transport/          mentra-io.ts · rtmp.ts · frames.ts · demo-server.ts · demo.html
│   │                       webview.ts · webview-panel.html
│   ├── engine/             engine.ts · request-engine.ts · vision.ts · tts.ts
│   ├── runtime/            session.ts                       ← NEW (replaces old orchestrator)
│   ├── toolkit/            host.ts · consent-audio.ts · prompt-block.ts   ← NEW
│   ├── audio/              render.ts · elevenlabs-map.ts · gemini-style.ts · speaker.ts  ← NEW
│   ├── skills/             types.ts · compose.ts · registry.ts
│   │   └── builtin/        task-guide.ts ← NEW · read-text-aloud.ts (trimmed)
│   └── tasks/              washing-machine.json (task BRIEF — facts, not wording) · bill.json
├── scripts/                drive-core.ts (trimmed) · import-profile.mjs ← NEW
└── test/                   render · prompt-block · elevenlabs-map · speaker · task-guide · import-profile
```

## 2. Parts bin — what comes over from the old `wearable/`

| File | Lines | Verdict | Trim on copy |
|---|---|---|---|
| `transport/mentra-io.ts` | 92 | **keep** | add the `SpeakOptions` pass-through: `speak(session, text, opts?)` → `session.audio.speak(text, opts)` |
| `transport/rtmp.ts` / `frames.ts` | 50 / 272 | **keep** | as-is |
| `transport/demo-server.ts` | 616 | **keep** | drop `/onboard` route + profile wiring; add `/state` (mode, captions, consent card, step) + `/say` (typed utterance) if not present |
| `transport/demo.html` | 1084 | **keep** | drop Setup/onboarding button; add A/B mode toggle, captions pane, consent card, big Done button |
| `transport/webview.ts` / `webview-panel.html` | 422 / 191 | **keep** | drop onboarding routes; add the same A/B toggle, captions, consent card, Done |
| `engine/engine.ts` / `request-engine.ts` | 34 / 64 | **keep — now central** | the request engine carries every content turn; temperature exposed (`LLM_TEMPERATURE`, default 0.2) |
| `engine/vision.ts` | 47 | **keep** | as-is (verification + read) |
| `engine/tts.ts` | 77 | **keep** | prepend the style line from `audio/gemini-style.ts` |
| `skills/types.ts` / `compose.ts` / `registry.ts` | 68 / 130 / 29 | **keep** | compose now assembles: base prompt + task brief + (toolkit mode) profile block; registry lists only `task-guide` + `read-text-aloud` |
| `skills/builtin/read-text-aloud.ts` | 211 | **keep** | delete `learnFromRead`/preference-file writes; keep `readVisibleText()` (text + `sizePct` + `kind`); gist-first via the profile block + render |
| `scripts/drive-core.ts` | 340 | **keep** | drop profile/onboarding wiring; boot `runtime/session.ts` |
| `src/index.ts` | 464 | **keep, heavy trim** | keep Mentra session lifecycle + webview mount; drop onboarding, profile gates, adapter-agent |
| `src/config.ts` / `runtime/env.ts` | 132 / 33 | **keep, trim** | drop `WEARABLE_SKILLS`, `SPEECH_STYLE`, live-engine and lux vars |
| `app_config.json` | — | **keep** | trim the `active_skills` options |
| `runtime/orchestrator.ts` | 458 | **drop** | replaced by `runtime/session.ts` (~150 lines, §3.5) |
| `runtime/adapter-agent.ts` | 207 | **drop** | draft-era skill recommender — the toolkit owns this concern |
| `profile/*` (4 files) | 494 | **drop** | the entire draft profile layer — replaced by the toolkit |
| `engine/live-engine.ts` / `live-client.ts` / `scripts/probe-live-video.ts` | 439 | **drop** | request engine only (film-day reliability) |
| `engine/light.ts` | 41 | **drop** | lux gating belongs to the dropped situational skills |
| `skills/builtin/` ping · contrast-reader · watch-your-step · pick-up-where-you-left-off · scene-describe | 671 | **drop** | not in either film; re-copy from the parts bin if ever wanted |
| `transport/onboarding.html` / `onboarding-shim.js` | 236+ | **drop** | replaced by the cleaned repo's `:4000/onboarding` |

Net: ~3,300 lines copied (≈2,900 of it the proven transport/demo surface),
~2,500 dropped, ~1,000 written new.

## 3. New modules — interfaces

### 3.1 `src/toolkit/host.ts`

```ts
export type GuideToolkit = { librarian: Librarian; datastore: Datastore };
export async function bootToolkit(opts: {
  dataDir: string;                 // APP_DATA_DIR, default ./data — NEVER the onboarding DATA_DIR
  consent: ConsentPort;            // consent-audio.ts
}): Promise<GuideToolkit>;         // createToolkit + runMigrations + minimal toolsRegistry

export async function ensureGrant(tk: GuideToolkit): Promise<'granted'|'declined'|'pending'>;
// requestGrant('wearable-extension',
//   ['ability.categories','settings.text','reading.level','language'],   // ALL scopes the render reads:
//   {appLabel:'Appliance Guide', …})                                     // without reading.level/language the
// → the Consent port presents it (spoken + panel) → on "yes": respondToProposal(id,'accept')
// exported model silently lacks readingLevel/language and video 2's dimension vanishes.
// The spoken consent copy names them: "…your accessibility profile — needs, speech, and reading level."

export async function readModel(tk: GuideToolkit): Promise<AbilityModel | null>;
// exportAbilityModel('wearable-extension'); null when no grant → caller falls back to defaults

export async function proposeInsight(tk: GuideToolkit, kind: string, change: object, rationale: string): Promise<void>;
```

**Packaging reality (symlink install assumed):** at the pinned commit the
toolkit's `exports` map has a `./platforms/node/kv.js` subpath, so `fileKV` is
imported by package name (`src/toolkit/host.ts`, `scripts/lib.mjs`) — no
copy. (Before commit `a71b34a` the subpath did not exist and the app carried a
copy; that gap was closed upstream.) `package.json`'s `files` allowlist now
covers `platforms/` and `registry/` but still omits `hosts/`, so Phase 0's
`demo:xr` acceptance relies on a symlink-style `file:` install (Bun's default);
a pack-style install would break it. Do **not** patch the toolkit (ground
rule 2); the remaining gap is a FOLLOW-UPS note.

### 3.2 `src/toolkit/prompt-block.ts` — the INPUT injection

```ts
export function profilePromptBlock(model: AbilityModel, r: AudioRender): string;
// Pure. Granted needs only — model.freeText never reaches the prompt.
// From r.delivery.mode==='stepwise': "Give exactly ONE next action, then stop and wait
//   for the user to say 'done'. Never list multiple steps."
//   + confirm-then-next: "When the user says 'done', acknowledge it in a few words
//   (e.g. 'Good, that's done.') and then give the next action."  (HoloAssist's
//   "confirming previous action" intervention type)
// From r.delivery.maxWordsPerUtterance: "Keep sentences under ~18 words."
// From r.language.simplify: "Plain everyday words — say 'soap', 'big dial'; no jargon."
// From r.speech.rate < 1: "Calm, unhurried phrasing; one short warm confirmation before each step."
// From r.delivery.gistFirst (video 2): "Give the one-sentence gist first; details only on request."
//   + orientation: "At the start of a task, say in one short sentence roughly how many
//   steps it has (the count only, not the steps) before the first action."
// Whenever the block is non-empty — elderspeak guard: "Speak to the wearer as a capable
//   adult: no endearments, no sing-song tone, no over-praise, no baby talk."
//   (Kemper & Harden 1999: slower/simpler delivery must not read as talking down.)
// Baseline mode: the block is simply absent — the model gets the normal input.
```

### 3.3 `src/toolkit/consent-audio.ts`

```ts
export function audioConsent(io: {
  speak(text: string): Promise<void>;
  showCard(card: ConsentCard | null): void;                 // demo + webview panels
  nextUtterance(timeoutMs: number): Promise<string | null>; // session's STT stream
}): ConsentPort;
// present: speak "…would like to read your accessibility profile — needs and speech. Okay?" + card
// capture: "yes"/"okay" → 'accept' · "no"/"not now" → 'declineOnce' · panel tap wins ties · null on timeout
```

### 3.4 `src/audio/` — the OUTPUT injection

- `render.ts` — `renderAudioSettings(model)`: the design doc §7.1 table
  verbatim; `model: null` → all defaults (that IS baseline).
- `elevenlabs-map.ts` — `toSpeakOptions(r)`: speed clamped 0.7–1.2; steady →
  `{stability: 0.75, style: 0}`; volume + `use_speaker_boost`; ONE constant
  `voice_id` under `FILM_MODE` (same-voice A/B rule).
- `gemini-style.ts` — `styleLine(r)`: laptop-TTS style instruction only.
- `speaker.ts` — `createSpeaker(sink, r)`: the one place speech is shaped.
  Chunk to `maxWordsPerUtterance`, silence `pauseAfterUtteranceMs` between
  chunks, done-gating hooks, repeat memory — `repeat()` **replays the
  transcript verbatim** (never regenerates); a second repeat of the same step →
  `speed − 0.1` (floor 0.7) and counts toward `onRepeatPattern` (the insight
  beat). `setRender(r)` re-renders live on A/B toggle. Guardrail: in toolkit
  mode chunking/gating apply even if the model rambles; in baseline the raw
  answer passes through unshaped — that is the point.

### 3.5 `src/runtime/session.ts`

```ts
export function createSession(deps: {
  frames: FrameStore; engine: ConversationEngine; speaker: Speaker;
  tk: GuideToolkit | null; panel: PanelBus; tasks: TaskLibrary;
}): {
  setMode(mode: 'baseline' | 'toolkit'): Promise<void>;
  // toolkit: ensureGrant → readModel → render + promptBlock; baseline: render(null), no block
  onUtterance(text: string): Promise<void>;
  // deterministic first: done|next · repeat|again · stop; task trigger by keyword; engine turn fallback
  state(): SessionState;    // for /state and the panels
};
```

Captions: every spoken line → `panel.caption(line)` when `captionsMirror`
(baseline shows only "Speaking…").

### 3.6 `src/skills/builtin/task-guide.ts` + `src/tasks/washing-machine.json`

The task file is a **brief — facts, not wording**. The model writes every
spoken line, in both modes:

```jsonc
{ "id": "washing-machine", "trigger": ["wash", "washing machine"],
  "goal": "start a cottons wash at 40°C",
  // The brief states facts in the MANUAL'S OWN register on purpose: an
  // unprompted model then naturally answers in manual terms ("compartment II",
  // "program selector"), and the profile block does the translating. That
  // keeps the baseline's register honest rather than staged — while the
  // GUARANTEED A/B contrast remains delivery shape, which is app-enforced.
  "brief": [
    "Front-loading washing machine.",
    "Dispenser drawer (top-left): compartments I, II, and softener; main-wash detergent goes in compartment II (the largest, left).",
    "Program selector dial (top): positions include Cottons, Synthetics, Delicates, Spin.",
    "Temp key cycles 20 → 40 → 60 °C; current value on the display.",
    "Start/Pause key: press and hold ~2 s until the indicator illuminates."
  ],
  "verify": [ { "afterActionMentioning": "dial",
                "prompt": "Is the machine's program dial pointing at 'Cottons'? Answer yes/no/unclear.",
                "sayOnYes": "I can see it's on Cottons. Good." } ] }
```

```ts
export function createTaskGuide(task: Task, engine: ConversationEngine, vision: Vision): TaskGuide;
// toolkit/stepwise: each turn asks the engine for the SINGLE next action (the profile
//   block enforces one-step answers; conversation history carries progress); 'done' → next turn
// baseline/continuous: one turn, full answer, spoken raw; 'repeat' → transcript replay
// verify: ONE vision call where the brief declares it; yes → sayOnYes; no/unclear/timeout → silence, never blocks
```

Pure policy over an injected engine — unit tests stub the engine with canned
replies and assert the turn requests + gating, not the model's prose.

### 3.7 `scripts/import-profile.mjs` + `scripts/reset-take.mjs`

```
node scripts/import-profile.mjs --uid margaret --seed \
  --from ../AI-for-Accessibility-Toolkit/onboarding/onboarding-data \
  --to ./data
```

Onboarding side via the cleaned repo's own `server/src/` helpers (`fileStore` +
`createToolkitHost` → `getInstance(uid)`). **`--seed` is required for the
demo** (design doc §3): the onboarding page only writes per-area default needs
(`captions`, `simplify`, plus a stray `reduceMotion`) and never parses free
text — so the seed step calls `setProfileField('fields.needs', [the four
needs])` on the onboarding store (public API), replacing the derived array and
recording accurate sources (`onboarding-derived` vs `setup-script`). Then
`exportProfileBlob()` (checked with `validateProfileBlob`) → app side
`bootToolkit` → `setActingUser` → `importProfileBlob`; prints the resulting
needs. **Run only while the onboarding server is stopped** (single-writer
stores). A checked-in `test/fixtures/margaret.blob.json` (the 4 needs) is the
test input and the no-onboarding fallback (`--fixture`).

`reset-take.mjs` — **the retake button.** Grants and insights are consent
proposals with dedup, decline cooldowns, and a default **3-proposals-per-week
cap**; a minted grant returns `already-granted` on the next ask. So the
consent and insight beats are only re-filmable from a fresh store:
`reset-take.mjs` wipes `APP_DATA_DIR` and re-imports the fixture blob (~10 s).
Used between every toolkit-mode take and in rehearsal loops; for long
rehearsal sessions `bootToolkit({rehearsal:true})` may pass the toolkit's
`demo` port (which lifts the weekly cap) — rehearsal only, never the filmed
take.

## 4. Phases

Every phase ends green: `bun test` + `tsc --noEmit` + the listed acceptance.

**Phase 0 — scaffold + demo surface alive (½ day).**
`bun init`; `file:` dep, commit pinned; copy the §2 keep-list with trims
applied on copy; stub `session.ts` (echoes utterances).
*Accept:* demo page serves; clip AND webcam sources show frames; typed
utterance echoes; the toolkit's own `demo:xr` passes from the linked dep.

**Phase 1 — toolkit host + Margaret (½ day).**
`toolkit/host.ts`, `import-profile.mjs` (with `--seed`), `reset-take.mjs`,
fixture blob; onboard "margaret" once at `:4000/onboarding` (ticking `hearing`
+ `cognitive` — the page labels raw area ids), then seed + import for real.
*Accept:* script prints exactly the 4 needs (no stray `reduceMotion`) with
accurate sources from the app store; round-trip and reset tests pass on temp
dirs.

**Phase 2 — the two injections (1 day).**
`audio/render.ts` + `elevenlabs-map` + `gemini-style` + `speaker` and
`toolkit/prompt-block.ts`, all with tests; demo `/tts` gets the style line;
`mentra-io` gets the SpeakOptions pass-through.
*Accept:* `render(margaret)` matches the spec table field-for-field;
`profilePromptBlock(margaret)` contains the one-step + plain-words + short-
sentence directives and NEVER contains `freeText`; baseline mode yields an
empty block and a default render. Speaker tests: chunking, pause timing,
transcript-replay repeat, second-repeat slowdown.

**Phase 3 — both films run in the browser (1½ days).**
`runtime/session.ts`, `task-guide.ts`, the washing-machine brief; A/B toggle +
captions + Done on both panels; live Gemini turns.
*Accept — the big one:* in the demo surface with a webcam, the entire video-1
A/B runs hardware-free with **generated** guidance: baseline answers the
question in one raw paragraph at 1.0× and repeats it verbatim; toolkit mode
does grant → one short plain step at a time at 0.8× with Done gating and
captions. `task-guide.test.ts` (stubbed engine) covers turn-shape, done/repeat,
verify-degrade, continuous mode.

**Phase 4 — consent + insight beats (½ day).**
`consent-audio.ts` wired into `ensureGrant`; `speaker.onRepeatPattern` →
`proposeInsight`; proposal card + accept in both panels.
*Accept:* spoken consent mints the grant (`listGrants`) with all four scopes
(`ability.categories`, `settings.text`, `reading.level`, `language`); two
repeats surface a pending proposal; accepting updates the model, the render,
AND the next prompt block — nothing applied silently. `reset-take.mjs` then
returns the store to pre-consent state and the whole beat replays cleanly.

**Phase 5 — vision verification + video 2 (1 day).**
Verify hook against the FrameStore + `engine/vision.ts`; `read-text-aloud`
trimmed, gist-first via block + render; `tasks/bill.json`; dial-photo and
prop-bill fixtures.
*Accept:* dial photo → verification line speaks on 'yes', silent on 'unclear';
the bill reads gist-first with "Want the details?" in toolkit mode, verbatim
in baseline.

**Phase 6 — glasses bring-up (1 day).**
Mentra console app (`app_config.json`), public URL, `RTMP_HOST`; real
SpeakOptions on-device; STT of "done" in a noisy room; consent by voice;
volume levels; then the design doc's dry-run checklist.
*Accept:* the full video-1 toolkit take, on glasses, twice in a row without
touching the laptop.

Total ≈ 6 build days; **budget 8–9 wall-clock** including rehearsal, filming
(design doc §9 rows 7–9), and slack — Phase 6 in particular is best-case as
listed.

## 5. Test matrix

| Test | Covers |
|---|---|
| `render.test.ts` | every render field vs the spec table; `null` model → defaults |
| `prompt-block.test.ts` | directives present per need; empty for `null` model; `freeText` never leaks |
| `elevenlabs-map.test.ts` | speed clamp 0.7–1.2; steady → stability/style; constant voice_id under FILM_MODE |
| `speaker.test.ts` | chunking; pause timing (fake timers); transcript-replay repeat + slowdown; stop cancels |
| `task-guide.test.ts` | stubbed engine: one-step turn requests in stepwise, single full turn in continuous; done/repeat/stop; verify yes/no/unclear/timeout; trigger match |
| `import-profile.test.ts` | fixture blob → temp store → exactly 4 needs with accurate sources; `--seed` replaces the derived array; `validateProfileBlob` gate; `reset-take` restores pre-consent state |
| manual (Phase 3/6) | the A/B acceptance runs above |

## 6. `.env.example`

| Var | Purpose | Default |
|---|---|---|
| `GEMINI_API_KEY` | content turns + vision + laptop TTS | — |
| `LLM_TEMPERATURE` | content-turn determinism for filming | `0.2` |
| `PACKAGE_NAME` / `MENTRAOS_API_KEY` | Mentra console app | — |
| `RTMP_HOST` / `PORT` | glasses stream + app server | LAN IP / 3000 |
| `APP_DATA_DIR` | toolkit file store (never the onboarding dir) | `./data` |
| `GUIDE_MODE` | boot mode; panels can toggle live | `baseline` |
| `FILM_MODE` | locks voice_id constant; disables voicePitch voice swap | `on` |
| `ELEVEN_VOICE_ID` | the one film voice | Mentra default |

## 7. Explicitly out (and where it lives)

Live engine, situational skills (ping / contrast-reader / watch-your-step /
pick-up-where-you-left-off / scene-describe), lux gating, the draft profile
layer, adapter-agent — all remain in the old draft's `wearable/` parts bin,
re-copyable on demand. Toolkit-side wishes (surfaces/audio.js upstream, the
three dimensions in the registry, `platforms/node` in the exports map + the
`files` allowlist gap, onboarding needs-capture so the seed step can retire,
audio-demo host, ControlPort receiver) stay in the design doc §7.4 follow-ups
list — filed against the cleaned repo after the demos prove them.
