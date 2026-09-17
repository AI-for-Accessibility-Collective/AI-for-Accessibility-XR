# wearable-extension — Appliance Guide

An audio-first smart-glasses guide (MentraOS) that walks a person through a
household task and reads what they are looking at. The guidance is generated
live by Gemini. The AI for Accessibility Toolkit adapts it to the person's
consented accessibility profile — and the demo films the **same app twice**,
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
4. Click **Toolkit**. The guide asks, out loud, for permission to use the
   profile — say *"yes"*. Now it gives **one step at a time**, slower, with
   captions. Say *"done"* (or press **✓ Done**) for the next step, *"repeat"*
   to hear a step again.
5. Between Toolkit takes run `bun run reset:take` — it puts the profile back
   to the pre-consent state so the permission question happens again.

Any other task works the same way: *"help me start the dishwasher"* makes the
model write a short brief first, and both modes then use that same brief.
Wear headphones if you can — the mic can hear the guide's own voice.

## 2. Run on the glasses (Mentra)

You need Mentra glasses paired to the MentraOS phone app, a Mentra developer
console account, and a tunnel such as `ngrok`. The glasses stream their camera
straight to this laptop over Wi-Fi; the app tells them to.

1. **Console app.** Create the app with your package name, the permissions in
   `app_config.json` (microphone, camera), and a public URL to this laptop's
   port 3000 — run `ngrok http 3000` and paste the URL it prints.
   The phone panel is that URL followed by `/webview`.
2. **`.env`.**

   | Key | Value |
   |---|---|
   | `PACKAGE_NAME`, `MENTRAOS_API_KEY` | from the console app |
   | `RTMP_HOST` | this laptop's Wi-Fi address (`ipconfig getifaddr en0` on a Mac) |
   | `PORT`, `RTMP_PORT` | leave the defaults (3000, 1935) |

3. **Network.** Glasses and laptop on the **same Wi-Fi**, and it must allow
   devices to talk to each other — guest and campus networks often don't.
   A phone hotspot with both on it is the safe choice. If the Mac firewall
   is on, allow incoming connections for bun.
4. **Glasses on Wi-Fi.** The HUD says *Connect glasses to WiFi* otherwise.
5. **Run.**

   ```bash
   bun run reset:take
   bun run start
   ```

   Open the app on the glasses and press **Start** on the phone panel. That one
   switch turns on Gemini and the camera. The HUD shows
   *Ready — Appliance Guide listening*, and http://localhost:3001 on the laptop
   shows what the glasses see. The terminal logs every camera status change.

This path has not been run on hardware from this repo yet — the first run is
a bring-up session (`docs/CHECKING.md` §6). The stream, the network, and
recognizing *"done"* in a real room are the usual things to adjust.

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

- **input** — `src/toolkit/prompt-block.ts` adds the consented profile's
  directives to the prompt (the person's free text never goes in);
- **output** — `src/audio/render.ts` shapes delivery: speaking rate, one step
  at a time, pauses, captions.

Baseline is the same app with those two switched off. Consent, the profile
store, and profile sharing are the toolkit's; the app never bypasses them.

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
