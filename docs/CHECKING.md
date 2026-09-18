# Checking the system

Run the layers in order — each assumes the ones above it passed.

| Layer | How | Time | Needs |
|---|---|---|---|
| 1. Automated, offline | `bun run check --offline` | ~30 s | the repo |
| 2. Automated, live models | `bun run check` | ~1 min | `GEMINI_API_KEY` in `.env` |
| 3. Automated, whole A/B film over HTTP | `bun run check --rig` | ~4 min | the key; ports 3900/3901 free |
| 4. Manual, browser rehearsal | §3 | ~15 min | Chrome, webcam, mic, headphones |
| 5. Manual, real onboarding profile (optional) | §4 | ~5 min | the toolkit repo's onboarding service |
| 6. Manual, on glasses | §6 | ~1 h | Mentra Live glasses, the phone app, the server |

The automated check uses temp directories and spare ports. It never touches
`./data`, the onboarding service's store, or the toolkit, so it is safe to run
next to a rehearsal. It exits non-zero only on a **✗**; a **!** is a warning
worth reading, not a failure.

## 0. Stopping — every time you're done

Any one of these turns Gemini off first, then shuts the demo down:

- the red **■ Stop** button at the top right of the demo page — the page then shows *Stopped*
- **Ctrl-C** in the terminal running `bun run demo` (or `bun run start` for the glasses app)
- `bun run stop` in any terminal

Then run **`bun run stop`** once more as the final word. It stops anything this
app left running (the demo, the glasses app, a check or model-bench run, their
video readers, and the old wearable draft's demo) and ends with
**✓ Stopped. Nothing from this app is running, listening, or connected to
Google.** A **✗** line means something survived — keep that output.

While the demo runs, these keep an unattended demo from spending:

| Safety net | What happens | Change it in `.env` |
|---|---|---|
| the demo page is closed | Gemini pauses immediately, and again 10 s after the last demo tab is gone | `PAUSE_WHEN_PAGES_CLOSED_SEC` |
| nobody is at the laptop | 15 minutes with no clicks or typing pauses Gemini | `AUTO_PAUSE_IDLE_MIN` |
| something loops | more than 40 Gemini requests in a minute, or 800 in one run, turns Gemini off until you restart the demo | `GEMINI_MAX_CALLS_PER_MINUTE`, `GEMINI_MAX_CALLS_PER_RUN` |
| the guide hears itself | the mic pauses while the guide talks, and anything it hears that repeats the guide's recent words is ignored | — |

`bun run check --offline` proves the Stop button and Ctrl-C each shut a real
demo process down.

**Not covered:** a copy of this app or the old draft running on another
machine (such as a server deployment). Stop it on that machine, or rotate the
Gemini key it uses.

## 1. What the automated check proves

### Offline

| Check | Proves | If it fails or warns |
|---|---|---|
| runtime | bun and node present; ffmpeg for clip/glasses sources | install node; `brew install ffmpeg` (webcam works without it) |
| secrets stay in .env | `.env` is gitignored; neither the key in use nor the key in `.env` appears in any other file; no request sends the key in a URL | move the key back into `.env`; **!** *no .env yet* just means layer 2 can't run |
| toolkit installed | `@ai4a11y/toolkit` is in `node_modules` | `bun install` |
| toolkit pinned commit | the sibling checkout tracks `github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit` (any other remote fails) and is at the commit this app was verified against | wrong remote: re-clone the Collective repo as the sibling; moved on purpose: rerun every layer, then update the pin in `README.md` and `scripts/check.ts` |
| toolkit untouched | no uncommitted changes under the sibling's `toolkit/` | revert them — toolkit wishes go to that repo's `docs/FOLLOW-UPS.md` |
| installed toolkit = sibling | every installed toolkit file links to (or matches) the sibling checkout, and none is missing — the app runs exactly the pinned code | `bun install` |
| typecheck, unit tests | render, prompt block (free text never leaks), ElevenLabs mapping, speaker, task guide and its finish detection, Toolkit mode adapting straight away, a mode toggle during a running switch, repeat, conversation history, profile import, the Gemini request layer (thinking fallback, key never in a URL or error, timeouts) | `bun test` for details |
| toolkit's own XR demo | the toolkit itself works from the installed files | a toolkit problem, not this app's |
| profile import / seed | the profile-blob pipeline, including `--seed` through the toolkit repo's own server helpers | read the needs the script prints |

### Live

| Check | Proves | If it fails or warns |
|---|---|---|
| models available | `VISION_MODEL` and `TTS_MODEL` exist on the key; notes if a newer flash model has appeared | fix the id in `.env` |
| text turn: baseline | the model answers the opening question with a complete reply | **✗ cut off** = thought tokens used up the output budget — see §5 |
| text turn: toolkit | under the profile block the reply is one short step, no manual jargon | a warning means the model drifted from the directives; rerun once, then see §5 |
| conversation memory | the model recalls a detail (the temperature) from the previous turn | the engine's history is not reaching the model |
| camera verify | Cottons photo → yes; Synthetics photo → no. A false **yes fails** (the guide would speak a wrong confirmation); *unclear* only warns (the guide stays silent) | model vision weakness — see §5 |
| bill read | exactly `$42.17` (not `$142.17`), `September 30, 2026`, and the sender — video 2's integrity | model vision weakness — see §5 |
| laptop voice | Gemini TTS returns audio | the page falls back to the browser voice |

### Rig (`--rig`)

Boots the demo harness on :3900/:3901 against a temp store holding Margaret's
fixture profile, then plays the film's beats and asserts each one:

1. baseline answers in **one raw utterance at 1.00×**
2. "repeat" replays it **word for word**
3. switching to Toolkit **reads the profile at once**, with nothing spoken → 0.8×, stepwise, captions
4. the washing-machine request gets **one short step at 0.8×**
5. "done" **advances** to a different step
6. "repeat" replays that step verbatim, still 0.8×
7. a second repeat says the **same words at 0.70×**; the profile itself still says 0.8×

A failed beat skips the rest. What the rig cannot see: the page's visuals,
real audio, microphone speech recognition, and the webcam — that's §3.

## 2. One-time setup for the manual passes

```bash
bun install
cp .env.example .env          # then set GEMINI_API_KEY
bun scripts/import-profile.mjs --fixture   # Margaret's profile into ./data
```

## 3. Browser rehearsal

Start `bun run demo` and open <http://localhost:3001> in **Chrome** (the page's
speech recognition is Chrome's). Allow the microphone. The demo boots in
Baseline.

**Wear headphones if you can.** The page pauses its mic while the guide's voice
plays (the listening strip reads *paused while the guide speaks…*) and resumes
the moment it stops, so answering right after a question works. Through
laptop speakers the room's echo can still reach the mic; headphones remove it.
Typing into the box under the **Done** button works as well as speaking.

| # | Do | You should see / hear |
|---|---|---|
| 1 | Source picker → **📷 Webcam** → **📷 Start webcam** | live mirrored feed; the switch still reads **▶ Start** (Gemini off) |
| 2 | Flip the switch | **● Live** and the red *Listening* strip. The click also unlocks browser audio. |
| 3 | **Guide mode** is **Baseline**. Say *"Hello? Can you help me start the washing machine? I want to wash my cottons at forty degrees."* | one long answer at normal speed; the feed overlay shows only *Speaking…*; the log has the full text |
| 4 | Say *"repeat"* | the identical words again |
| 5 | Click **Toolkit**. The guide is Live, so a pop-up asks first — press **Pause and switch to Toolkit** | the switch drops back to **▶ Start** (a take is one mode from Start to pause; switching while paused shows no pop-up). Nothing is asked: **My Profile** shows **in use** and four needs with where each came from (hover a row for the raw need and source); the chips under the mode switch turn green and read *0.8× speed · one step at a time · captions*; the badge on the feed reads *Toolkit · profile on* |
| 6 | Flip the switch back to **● Live**, then say the washing-machine line again | **one** short step, slower and calmer; caption text on the feed; *Task: washing-machine · step 1*; **✓ Done — next step** enabled |
| 7 | Press **✓ Done — next step** (or say *"done"*) until the guide tells you to turn the dial | one new step each time, in plain words |
| 8 | Right after the dial step, show `test/fixtures/dial-cottons.jpg` (e.g. on a phone) to the webcam | *"I can see it's on Cottons. Good."* — with `dial-synthetics.jpg` instead: silence. The check runs once per task. |
| 9 | Say *"repeat"*, then *"can you say that again?"* | the dial step twice, word for word (not the confirmation), the second a little slower; nothing else is said, and **My Profile** still shows *Speaking rate 0.8×* |
| 10 | Keep pressing **Done** until the end | after the last step it says the wash is running and **Done** turns off |
| 11 | Video 2: say *"what does this say?"* holding up `test/fixtures/bill.jpg` | Toolkit: the gist first (who, how much, by when). Switch to **Baseline** and ask again: *"It says: …"* verbatim |

**Other tasks.** Only the washing machine and the bill have scripts (the
appliance facts in `src/tasks/*.json` and the camera check). Any other request
to be guided — *"help me start the dishwasher"*, *"how do I set the microwave
clock?"*, *"walk me through…"* — first has the model **write the brief**: one
call from your words and the camera view, with no profile or mode in that
prompt. The log shows *Working out the task…* and then *Brief written by the
model…* with the facts; the *Task:* line shows the goal it understood. The
brief is kept for the rest of the run, so the Baseline take and the Toolkit
take of the same request read identical facts — only the delivery differs,
as with the scripted tasks. Then it runs like any task: one step at a time
and **Done** in Toolkit mode, one full answer in Baseline, *"repeat"* and
*"stop"* as usual. There is no camera check for these. If the brief cannot be
written (Gemini off, no answer), the guide runs from your request alone and
says so. Plain questions (*"what is this?"*, *"is it on?"*) stay conversation.
Triggers match whole words: *"dishwasher"* and *"wash the car"* never pick up
the washing-machine script.

**Between takes** there is nothing to reset: the app only reads the profile,
so every Toolkit take starts from the same one. Switching mode clears the
task and the repeat memory.

## 4. Real onboarding profile (optional)

The fixture profile stands in for onboarding. To use the real flow:

1. In `../AI-for-Accessibility-Toolkit`: `ADMIN_PASSWORD=dev node onboarding/server.js`
2. Open <http://127.0.0.1:4000/onboarding>, onboard uid **margaret**, tick **hearing** and **cognitive**.
3. **Stop the service** — the stores are single-writer.
4. Back here: `bun scripts/import-profile.mjs --uid margaret --seed`
5. Expect the four needs printed with a ✓ line. `--seed` is required: the onboarding page only derives captions and simplify from the ticked areas; `readAloudRate` and `pacing` come from the seed step, and the printed sources say so.

## 5. Changing the Gemini model

- Set `VISION_MODEL` in `.env` to a **pinned id** (e.g. `gemini-3.5-flash`),
  never an alias like `gemini-flash-latest` — an alias can move mid-shoot.
- Thinking behaves differently per model. `src/engine/gemini-rest.ts` asks for
  no thinking and steps down automatically (no thinking → low → the model's
  default) when a model refuses; the log says which rung stuck. Thought tokens
  count against the output cap, which is why the caps carry headroom.
- After any change: `bun run check`, then `bun run check --rig`. Watch the
  latency on the text turns — every step of the film waits on it.

### Current choice: `gemini-3.5-flash` — picked by benchmark, not by recency

On 2026-09-14 the seven text models on the key ran the app's own prompts: the
baseline answer and a follow-up, the toolkit opening, a full stepwise
walkthrough, the dial check (yes and no), the bill read, and the bill gist.
Four blind judges then scored the transcripts — for accessibility, film
honesty, correctness, and worst-case risk on a live take — and a devil's
advocate tried to overturn the pick.

| Model | Wait per step (median) | Verdict |
|---|---|---|
| **gemini-3.5-flash** | **0.9 s** | **chosen** — correct every run, the strictest about one action per turn, nearly identical run to run (the rehearsal *is* the take) |
| gemini-3.6-flash | 3.4 s, 8 s on the first step | runner-up — safest wording and the best bill gist, but its step order changed between runs |
| gemini-3.7-flash | 2.6 s | close third — bundled two actions into one step on camera |
| gemini-3.8-flash (newest) | 3.5 s, 8.7 s slow tail | rejected — invented a drawer layout in a baseline answer; thinking can't be turned off |
| gemini-3.1-pro-preview (= `gemini-pro-latest`) | 6–7 s | rejected — accurate, but ~30 s of silence per walkthrough and a stalled baseline answer |
| gemini-2.5-flash | 0.55 s | rejected — vague soap instruction; looped its closing line |

Watch for these with 3.5-flash in rehearsal:

- praise that builds over the steps ("You are doing great", "Awesome")
- "the big dial on the front" — the brief says top; match it to the prop machine
- in the bill gist, details nobody asked for (it read out the phone number once,
  and once invented "you will need your account number")
- the baseline answer runs 124–144 words, about 50 s at normal speed — longer
  than the baseline segment

To compare models again when a new one appears:

```bash
bun scripts/bench-models.ts --models gemini-3.5-flash,gemini-3.9-flash --out bench-out
```

It writes `bench-out/results.json`, per-scenario transcripts under
`bench-out/blind/` labelled only by letter, and the letter-to-model key in
`bench-out/key.json`. Hand only `blind/` to whoever judges, and read latency
from the printed summary.

## 6. On glasses (Phase 6 — not yet exercised)

1. One-time setup from README §2: glasses on the software matching the
   Bluetooth SDK, server deployed with a `BRIDGE_TOKEN`, phone app built with
   the same token and installed.
2. `bun scripts/import-profile.mjs --fixture` on the server (once).
3. Phone app: *Guide server* says **Connected**; scan, connect the glasses, and
   put them on Wi-Fi from the same screen. `journalctl -u wearable-a11y -f` on
   the server shows the phone connecting.
4. Press Start in the phone app. Expect *Ready — Wearable Task Guide listening*,
   and `<public URL>/debug/frame` showing the glasses camera. If the camera
   fails, the log says why on each of its five attempts.
5. Baseline take by voice — listen for normal speed and one long answer.
6. Switch to Toolkit in the phone app. Listen for the slower delivery (the
   voice is Gemini TTS, steered by the profile) and the caption on the phone.
7. In a realistically noisy room: is *"done"* recognized? Is the volume right?
   Speech is cut into utterances by loudness (`src/engine/stt.ts`); if room
   noise keeps an utterance open, raise `threshold` there.
8. Acceptance: the full toolkit take, twice in a row, without touching the laptop.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| the guide answers things you never said, or talks to itself | room echo of the guide's voice reached the mic between phrases | wear headphones, or type instead of speaking |
| a reply stops mid-sentence; the log says `non-STOP finish: MAX_TOKENS` | thought tokens used the output budget | §5; raise the caller's cap |
| the guide says *"Sorry, I didn't manage that"*; the log shows `Guide error — gemini … HTTP 429` or `timed out` | the model call failed (rate limit, network, timeout) — the app keeps running | wait a moment and repeat the request; *"repeat"* still replays the last real step |
| *Toolkit mode — no profile in the store, running with defaults* | `./data` is empty, or `APP_USER` names someone with no profile | `bun scripts/import-profile.mjs --fixture`, then click **Baseline** and **Toolkit** again |
| the page loads but nothing answers | the switch is off — changing source also turns it off | flip the switch |
| replies in the log but no laptop audio | the browser hasn't had a click yet, or Gemini TTS failed and the browser voice is blocked | click the page once; check the *laptop voice* line of `bun run check` |
| `EADDRINUSE` on start | another demo is running | stop it, or set `PORT` / `DEMO_PORT` |
| check fails *the app would not run the pinned toolkit* | installed toolkit files are missing or differ from the sibling | `bun install` |
