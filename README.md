# wearable-extension — Wearable Task Guide

An audio-first smart-glasses guide (MentraOS) that walks a person through a
household task and reads what they are looking at. The guidance is generated
live by Gemini. The AI for Accessibility Toolkit adapts it to the person's
accessibility profile — and the demo films the **same app twice**,
once without that adaptation (Baseline) and once with it (Toolkit). That
contrast is the film (`docs/DESIGN.md`).

## Before you start

- **bun**, **node 22+**, and **ffmpeg** (`brew install ffmpeg`; only the
  webcam source works without it).
- A **Gemini API key** (Google AI Studio). It goes in `.env` and nowhere else.
- The toolkit repo cloned **next to** this one — the app links it as a sibling:

```
toolkitv2/
├── AI-for-Accessibility-Toolkit/   ← github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit
└── wearable-extension/             ← this repo
```

## 1. Run the demo in your browser (no glasses needed)

```bash
bun install                                # links the sibling toolkit
cp .env.example .env                       # then put your GEMINI_API_KEY in .env
bun scripts/import-profile.mjs --fixture   # Margaret's profile → ./data
bun run demo                               # opens on http://localhost:3001
```

On the page:

1. **Source** → **📷 Webcam** → **Start webcam**. (For a recorded clip
   instead, drop a `.mov`/`.mp4` into this folder and pick it from the list.)
2. Flip the switch to **▶ Start**. Gemini only runs while it is on.
3. Say or type *"help me start the washing machine"*.
   **Baseline** answers in one long paragraph at normal speed.
4. Click **Toolkit**. A take runs in one mode, so if the guide is Live a
   pop-up pauses it first — confirm, then flip **▶ Start** again. The guide
   reads the profile straight away. Now it gives **one step at a time**,
   slower, with captions. Say *"done"* (or press **✓ Done**) for the next
   step, *"repeat"* to hear a step again.

Any other task works the same way: *"help me start the dishwasher"* makes the
model write a short brief first, and both modes then use that same brief.
Wear headphones if you can — the mic can hear the guide's own voice.

## 2. Run on the glasses (Mentra Live)

Three pieces, and only the first is yours to carry:

```
glasses ⇄ Bluetooth ⇄ phone app (phone/) ⇄ internet ⇄ guide server (src/)
glasses ────────── camera, over Wi-Fi ──────────────▶ guide server
```

- The **phone app** (`phone/`, React Native on Mentra's **Bluetooth SDK**) holds
  the link to the glasses. It forwards the glasses microphone to the server,
  plays the guide's voice (the phone routes it to the glasses speaker), and
  tells the glasses where to send their camera. It replaces the Mentra app for
  this demo — Mentra's cloud SDK, developer console and tunnels are not used.
- The **guide server** (this repo's `src/`) runs on a server of your own
  (ours is a small GCP VM, nginx in front for HTTPS; its name and URL live in
  this repo's `.env`, see `.env.example`). It turns speech into text, runs
  Gemini and the toolkit, and makes the voice.

### One-time setup

1. **Update the glasses.** The Bluetooth SDK (3.1.1) only works with the
   matching Mentra Live software. Follow
   [Update Mentra Live](https://docs.mentraglass.com/bluetooth-sdk/software-update)
   once.
2. **Server.** `bun run deploy` uploads this repo + the sibling toolkit and
   restarts the systemd service `wearable-a11y` (app in
   `~/a11y-toolkit/wearable-extension`; nginx forwards the URL to it). Deploying
   never touches the server's `.env` or `data/`. The server `.env` differs from
   `.env.example` in:

   | Key | Value |
   |---|---|
   | `BRIDGE_TOKEN` | the shared secret the phone app must present |
   | `ADMIN_PASSWORD` | what a browser is asked for at `/webview` and `/webview/runs` |
   | `RTMP_HOST` | the server's public IP — the glasses publish RTMP straight to it |
   | `PORT`, `RTMP_PORT`, `DEMO_PORT` | 3700, 1936 (open in the GCP firewall), 3701 |

3. **Phone app.** Needs Xcode (iPhone) or Android Studio (Android) and the
   phone on a USB cable.

   ```bash
   cd phone
   bun install
   cp .env.example .env      # the server's URL, and its BRIDGE_TOKEN
   bun run ios:release       # or: bun run android:release
   ```

   The `:release` builds run on their own; `bun run ios` / `bun run android`
   make a development build that needs this laptop running `bun run start`.
   The URL and token are baked in at build time — rebuild after changing them.
   On an iPhone, the first build asks you to pick a signing team in Xcode
   (`phone/ios/*.xcworkspace` → Signing & Capabilities).

### Each session

1. Open **Wearable Task Guide** on the phone. *Guide server* should say
   **Connected**.
2. **Scan for glasses** → **Connect**. The app remembers them and reconnects
   next time. On an iPhone, also select the glasses in Settings › Bluetooth so
   the voice comes out of them; Android asks to pair on its own.
3. If *Wi-Fi* says not connected, enter a network there — the camera streams
   over Wi-Fi (any network with internet; a phone hotspot works).
4. Press **▶ Start**. That one switch turns on Gemini, the camera and the
   microphone. When it says *Ready — Wearable Task Guide listening*, speak.
   **Baseline / Toolkit**, **✓ Done** and **↻ Repeat** are on the same screen,
   and at `/webview` on the server's URL for a second person (it asks for
   `ADMIN_PASSWORD`).

```bash
gcloud compute ssh "$DEPLOY_VM" --zone="$DEPLOY_ZONE"  # then, on the server:
journalctl -u wearable-a11y -f                         # logs: phone, camera, every status change
sudo systemctl stop wearable-a11y                      # off for good (■ Stop only restarts it)
```

To see what the glasses see, tunnel the demo page (it isn't public):
`gcloud compute ssh "$DEPLOY_VM" --zone="$DEPLOY_ZONE" -- -L 3701:localhost:3701`,
then open http://localhost:3701.

The guide does not listen while it is speaking (so it never hears itself):
wait for a line to finish before saying *"done"*, or press the button.

The server and the phone link are tested end to end with a stand-in phone; the
app compiles. It has **not been run on real glasses yet** — the first run is a
bring-up session (`docs/CHECKING.md` §6). Bluetooth audio routing, the camera
stream and hearing *"done"* in a real room are the usual things to adjust.

## 3. Stop it — every time

**■ Stop** on the page, **Ctrl-C** in the terminal, or **`bun run stop`** from
any terminal. Each turns Gemini off first, then shuts the app down. End every
session with `bun run stop`: it stops anything left over and confirms nothing
can still call Gemini. On its own, the app pauses Gemini when the page is
closed or after 15 idle minutes, and turns it off if requests run away.

## 4. Check it

```bash
bun run check              # everything, including a few live Gemini calls
bun run check --offline    # no Gemini calls
bun run check --rig        # also plays the whole A/B film over HTTP
```

The manual passes (browser rehearsal, real onboarding, glasses) and the
troubleshooting table are in `docs/CHECKING.md`.

## How it works, briefly

The model writes every spoken line in both modes from one prompt: a base
persona plus a **task brief** — appliance facts for the washing machine and
the bill (`src/tasks/*.json`), model-written for any other task
(`src/skills/task-brief.ts`). The toolkit contributes exactly two things:

- **input** — the profile adds directives to the prompt (the person's free
  text never goes in);
- **output** — the profile shapes delivery: speaking rate, one step at a
  time, pauses, captions.

Baseline is the same app with those two switched off.

## The toolkit and this app — who does what

The **toolkit** knows the person. The **wearable extension** knows the glasses
and the task. The toolkit never sees or speaks; the app never saves its own
copy of the profile.

The toolkit works in three layers, and the wearable follows the same three:

| Layer | What it does | Who provides it here |
|---|---|---|
| **Profile** | What the person needs: speech rate, plain language, captions… | Toolkit |
| **Surface** | Turns those needs into settings for one medium. It decides; it does nothing. | Toolkit's XR surface, plus a small audio add-on in this repo (`xr-audio.ts`) — the toolkit's XR surface is built for headsets you look through, and has no pacing, pauses or pitch |
| **Adapters** | Each carries out one kind of setting | This repo: prompt directives (plain words, one step at a time), paced delivery (short chunks, pauses), voice (rate, pitch). The toolkit's own adapters all change web pages, and glasses have no page. |

Around those, the app adds what is only its own: the glasses (camera,
microphone, voice) and the guide — Gemini writes the steps for the task.

The add-on surface and the adapters live in one folder,
`src/toolkit-candidates/`, which imports the toolkit but never the rest of the
app. They are written here first and meant to move into the toolkit, so other
wearable apps can use them; that folder's README says what would go, and in
what order.

### How they talk

The toolkit runs inside the app as a library — no server, no network. The app
talks to it at two moments:

1. **Start.** The app opens the toolkit on its data folder (`./data`), where
   the profile lives (`src/toolkit/host.ts`).
2. **Read.** When Toolkit mode is switched on, the app asks the toolkit for
   the profile, and the surface turns it into settings
   (`src/toolkit-candidates/xr-audio.ts`, which calls the toolkit's XR
   surface). The adapters carry those settings out in two places: the prompt
   and the delivery.

Baseline skips step 2 and speaks with default delivery. The toolkit is used as
it is — never modified from here. (Setting up `./data` is a separate script,
`scripts/import-profile.mjs`.)

## Toolkit pin

`@ai4a11y/toolkit` is a `file:` dependency on
`../AI-for-Accessibility-Toolkit/toolkit`, verified against commit
**`a71b34a`** of the Collective repo; `bun run check` fails if the sibling
tracks any other remote. Bun installs it as symlinks into the checkout, so
toolkit edits apply immediately (added or removed files need `bun install`).
The toolkit is never modified from here — wishes go to that repo's
`docs/FOLLOW-UPS.md` (`docs/DESIGN.md` §7.4).

## More

`docs/DESIGN.md` — the film and its integrity rules · `docs/PLAN.md` — build
plan and source layout · `docs/CHECKING.md` — the runbook · `bun test` ·
`bun run typecheck`
