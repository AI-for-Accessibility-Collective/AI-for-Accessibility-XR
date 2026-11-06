# AI for Accessibility XR

Smart-glasses guidance, adapted by the
[AI for Accessibility Toolkit](https://github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit).

The app is an audio-first guide for [Mentra Live](https://mentraglass.com/live) glasses. It guides a person
through a household task one step at a time, and it reads out what they are
looking at. Gemini generates the guidance at run time. The toolkit adapts how that
guidance is worded and spoken to the person's accessibility profile.

The same app runs in two modes. **Baseline** speaks with default delivery.
**Toolkit** reads the profile and adapts. Switching between the two on the
same task is how the difference is shown (`docs/DESIGN.md`).

## How it uses the toolkit

The toolkit stores the person's profile. This app handles the glasses and
the task, and reads the profile from the toolkit.

The toolkit runs inside the app as a library. The app calls it at two moments:

1. **Start.** The app opens the toolkit on its data folder, where the profile
   is stored. The code is `src/toolkit/host.ts`. All of the app's calls into
   the toolkit go through that file.
2. **Read.** When Toolkit mode is on, the app asks the toolkit for the
   profile. A surface turns the profile into audio settings, and adapters
   apply those settings. The code is in `src/toolkit-candidates/`.

The settings are applied in two places:

- **The prompt.** The profile adds directives such as plain words, or one
  step at a time. The person's free text is left out of the prompt.
- **The delivery.** The profile sets speaking rate, chunk length, pauses
  and captions.

Baseline skips the read and speaks with defaults.

### The three layers

The toolkit is built in three layers. This app follows the same three.

| Layer | What it does | Provided by |
|---|---|---|
| **Profile** | What the person needs: speech rate, plain language, captions | The toolkit |
| **Surface** | Turns needs into settings for one medium. It makes the decisions, and the adapters act on them. | The toolkit's XR surface, plus `xr-audio.ts` in this repo. The XR surface was built for headsets you look through. The add-on covers pacing, pauses and pitch. |
| **Adapters** | Each applies one kind of setting | This repo: prompt directives, paced delivery, voice. The toolkit's own adapters are written for web pages, so glasses need their own. |

The add-on surface and the adapters are in `src/toolkit-candidates/`. That
folder's imports come from the toolkit and from itself, and a test checks
this. The code was written here first and is intended to be moved into the
toolkit.
The folder's README lists what would move, and in what order.

The toolkit is used unmodified. Requests for changes to it belong in that
repo.

## What is in the repo

```
src/toolkit/             the app's calls into the toolkit, and the needs it can write
src/toolkit-candidates/  the audio surface and the adapters, to be moved upstream
src/engine/              Gemini: content turns, vision, speech to text, text to speech
src/runtime/             a session (one take and its turns), the spoken setup, take recording
src/skills/              the task guide, the read-aloud skill, the task brief
src/transport/           the phone bridge, the camera stream, the browser panel
src/tasks/               appliance facts for the washing machine and the bill
phone/                   the phone app (React Native, Mentra Bluetooth SDK)
scripts/                 deploy, stop, check, import a profile
docs/                    design, plan, runbook
```

## Before you start

- **bun**, **node 22+**, and **ffmpeg** (`brew install ffmpeg`). Without
  ffmpeg, the webcam is the one source that works.
- A **Gemini API key** from Google AI Studio. Put it in `.env`, which git
  ignores.
- The toolkit repo cloned **next to** this one. The app links it as a sibling:

```
<parent>/
├── AI-for-Accessibility-Toolkit/   github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit
└── AI-for-Accessibility-XR/        this repo (any folder name works)
```

## 1. Run it in your browser

```bash
bun install                                # links the sibling toolkit
cp .env.example .env                       # then put your GEMINI_API_KEY in .env
bun scripts/import-profile.mjs --fixture   # a sample profile (Margaret) into ./data
bun run demo                               # opens on http://localhost:3001
```

On the page:

1. **Source**, then **📷 Webcam**, then **Start webcam**. For a recorded clip,
   drop a `.mov` or `.mp4` into this folder and pick it from the list.
2. Flip the switch to **▶ Start**. Gemini runs while it is on.
3. Say or type *"help me start the washing machine"*. **Baseline** answers in
   one long paragraph at normal speed.
4. Click **Toolkit**. A take runs in one mode, so if the guide is live a
   pop-up pauses it first. Confirm, then flip **▶ Start** again. The guide
   reads the profile and now gives one step at a time, slower, with captions.
   Say *"done"* or press **✓ Done** for the next step. Say *"repeat"* to hear
   a step again.

Other tasks work the same way. *"Help me start the dishwasher"* makes the
model write a short brief first, and both modes then use that brief. Wear
headphones if you can, because the mic can hear the guide's own voice.

## 2. Run it on the glasses (Mentra Live)

Three parts:

```
glasses ⇄ Bluetooth ⇄ phone app (phone/) ⇄ internet ⇄ guide server (src/)
glasses ────────── camera, over Wi-Fi ──────────────▶ guide server
```

- The **phone app** (`phone/`, React Native on Mentra's Bluetooth SDK) maintains
  the Bluetooth connection to the glasses. It forwards the glasses microphone to the server.
  It plays the guide's voice, which the phone routes to the glasses speaker.
  It tells the glasses where to send their camera. It replaces the Mentra
  app in this setup.
- The **guide server** (this repo's `src/`) runs on a server of your own.
  Ours is a small GCP VM, with nginx handling HTTPS. Its name and URL go
  in this repo's `.env` (see `.env.example`). It turns speech into text, runs
  Gemini and the toolkit, and produces the speech audio.

### One-time setup

1. **Update the glasses.** The Bluetooth SDK (3.1.1) works with the matching
   Mentra Live software. Follow
   [Update Mentra Live](https://docs.mentraglass.com/bluetooth-sdk/software-update)
   once.
2. **Server.** `bun run deploy` uploads this repo and the sibling toolkit,
   then restarts the systemd service `wearable-a11y`. On the server the app
   is installed in `~/a11y-toolkit/<this folder's name>`, and nginx forwards the URL
   to it. Deploying keeps the server's `.env` and `data/` unchanged. The server
   `.env` differs from `.env.example` in:

   | Key | Value |
   |---|---|
   | `BRIDGE_TOKEN` | the shared secret the phone app must present |
   | `ADMIN_PASSWORD` | what a browser is asked for at `/webview` and `/webview/runs` |
   | `RTMP_HOST` | the server's public IP. The glasses publish RTMP directly to it. |
   | `PORT`, `RTMP_PORT`, `DEMO_PORT` | 3700, 1936 (open in the GCP firewall), 3701 |

3. **Phone app.** Needs Xcode (iPhone) or Android Studio (Android), and the
   phone on a USB cable.

   ```bash
   cd phone
   bun install
   cp .env.example .env      # the server's URL, and its BRIDGE_TOKEN
   bun run ios:release       # or: bun run android:release
   ```

   The `:release` builds run standalone. `bun run ios` and
   `bun run android` make a development build that needs this laptop running
   `bun run start`. The URL and token are set at build time, so rebuild
   after changing them. On an iPhone, the first build asks you to pick a
   signing team in Xcode (`phone/ios/*.xcworkspace`, Signing & Capabilities).

### Each session

1. Open **Wearable Task Guide** on the phone. *Guide server* should say
   **Connected**.
2. **Scan for glasses**, then **Connect**. The app remembers them and
   reconnects next time. On an iPhone, also select the glasses in Settings ›
   Bluetooth so audio plays through them. Android asks to pair on its own.
3. If *Wi-Fi* says not connected, enter a network there. The camera streams
   over Wi-Fi, and a phone hotspot works.
4. Press **▶ Start**. That one switch turns on Gemini, the camera and the
   microphone. When it says *Ready, Wearable Task Guide listening*, speak.
   **Baseline / Toolkit**, **✓ Done** and **↻ Repeat** are on the same
   screen. They are also at `/webview` on the server's URL for a second
   person, behind `ADMIN_PASSWORD`.

```bash
gcloud compute ssh "$DEPLOY_VM" --zone="$DEPLOY_ZONE"  # then, on the server:
journalctl -u wearable-a11y -f                         # logs: phone, camera, status changes
sudo systemctl stop wearable-a11y                      # stops it until started again (■ Stop restarts it)
```

To view the camera stream, tunnel the demo page, which listens on the
server's localhost:
`gcloud compute ssh "$DEPLOY_VM" --zone="$DEPLOY_ZONE" -- -L 3701:localhost:3701`,
then open http://localhost:3701.

The microphone is off while the guide is speaking. Wait for a line to finish
before saying *"done"*, or press the button.

The first run on a new pair of glasses is a bring-up session
(`docs/CHECKING.md` §6). Bluetooth audio routing, the camera stream and
hearing *"done"* in a real room are the usual things to adjust.

## 3. Stop it when you are done

**■ Stop** on the page, **Ctrl-C** in the terminal, or **`bun run stop`**
from any terminal. Each turns Gemini off first, then shuts the app down. End a
session with `bun run stop`. It stops anything left over and confirms Gemini
is off. On its own, the app pauses Gemini when the page is
closed or after 15 idle minutes, and turns it off past the call limits in
`.env`.

## 4. Check it

```bash
bun run check              # everything, including a few live Gemini calls
bun run check --offline    # skips the live Gemini calls
bun run check --rig        # also plays the whole A/B take over HTTP
bun test                   # unit tests
bun run typecheck
```

The manual passes (browser rehearsal, real onboarding, glasses) and the
troubleshooting table are in `docs/CHECKING.md`.

## Toolkit pin

`@ai4a11y/toolkit` is a `file:` dependency on
`../AI-for-Accessibility-Toolkit/toolkit`, checked against commit
**`a71b34a`** of the toolkit repo. `bun run check` fails if the sibling
tracks a different remote. Bun installs it as symlinks into the checkout, so
toolkit edits apply immediately. Added or removed files need `bun install`.

## More

- `docs/DESIGN.md`: the two-mode comparison and the rules for a fair comparison
- `docs/PLAN.md`: build plan and source layout
- `docs/CHECKING.md`: the runbook
- `src/toolkit-candidates/README.md`: what should move into the toolkit

## Contact

For a bug or a question about this repository, open an [issue](../../issues)
here. For anything else, use the Collective's
[contact form](https://forms.gle/pTH6nSKMXmqbx9Eg8) or email
ai4a11y-collective-contact@googlegroups.com. The other routes, including
those for security problems and code of conduct reports, are in the toolkit's
[MAINTAINERS.md](https://github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit/blob/main/MAINTAINERS.md).
For more about the project, see the Collective's website,
[aiforaccessibilitycollective.org](https://aiforaccessibilitycollective.org).
