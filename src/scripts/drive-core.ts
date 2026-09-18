// Hardware-free harness: run the ENTIRE Mentra-agnostic core (frames →
// session → engine → speaker) with NO glasses and NO Mentra app.
//
//   GEMINI_API_KEY=... bun run demo        (opens the demo view's source picker)
//
// The video source is chosen LIVE in the demo view (http://localhost:3001)
// and can be switched anytime — clip / webcam / smartglass RTMP all feed the
// same FrameStore. Switching source pauses Gemini; the page's Start switch is
// what turns Gemini on, so it never bills until you say so.
//
// Both films run here end-to-end (docs/PLAN.md Phase 3 acceptance): toggle
// Baseline/Toolkit on the rail, speak or type "help me start the washing
// machine", say "done" between steps.
//
// Stopping — each of these halts Gemini first, closes the video sources and
// exits: the page's ■ Stop button, Ctrl-C here, the terminal closing, or
// `bun run stop` from any terminal. While it runs, closing the last demo page
// or a long stretch without clicks or typing pauses Gemini, and the runaway
// guard (engine/gemini-rest.ts) turns Gemini off if requests pile up.
//
//   --browser-cam  preselect the webcam        --rtmp  preselect the RTMP stream
//   <file>         preselect that clip

import { createInterface } from 'readline';
import { existsSync, readdirSync } from 'fs';
import { basename, extname, resolve } from 'path';
import { config, demoPortConflict, requireGeminiKey } from '../config.ts';
import { FrameStore, startFrameCapture, startFileFrameCapture } from '../transport/frames.ts';
import { startRtmpServer, stopRtmpServer } from '../transport/rtmp.ts';
import {
  startDemoServer,
  type DemoServerHandle,
  type DemoSource,
  type SourceSelection,
} from '../transport/demo-server.ts';
import { synthesizeSpeech } from '../engine/tts.ts';
import { VisionClient } from '../engine/vision.ts';
import { createConversation } from '../engine/request-engine.ts';
import { abortInFlightGemini, configureGeminiGuard, geminiHaltReason, haltGemini } from '../engine/gemini-rest.ts';
import { createSpeaker, type SpeakerSink } from '../audio/speaker.ts';
import { styleLine } from '../toolkit-candidates/adapters/voice.ts';
import { bootToolkit, type GuideToolkit } from '../toolkit/host.ts';
import { createSession, type Session, type SessionDeps } from '../runtime/session.ts';
import { createRunRecorder, type RunEventExtras, type RunEventRef } from '../runtime/run-recorder.ts';
import type { Task } from '../skills/types.ts';
import washingMachine from '../tasks/washing-machine.json';
import bill from '../tasks/bill.json';

requireGeminiKey();

const browserCam = process.argv.includes('--browser-cam');
const rtmpFlag = process.argv.includes('--rtmp');
const videoFile = process.argv.slice(2).find((a) => !a.startsWith('--'));

const TASKS: Task[] = [washingMachine as Task, bill as Task];

// ---- process state + stopping -------------------------------------------------
// Declared before anything can await, so a Ctrl-C during boot shuts down cleanly.

const frames = new FrameStore(config.frameRingSize);
let demo: DemoServerHandle | null = null;
let session: Session | null = null;
let producer: { stop: () => void } | null = null;
let rtmpUp = false;
let currentClipId: string | undefined;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

// Past runs: every Start→pause take is kept on disk, same as on the glasses
// (the pages that show them are served by the glasses server, /webview/runs).
const runs = createRunRecorder({ dir: config.runsDir, keep: config.runsKeep });
runs.recover();

// Everything the page shows also goes into the running take, if there is one.
function emit(e: { type: 'user' | 'assistant' | 'status' | 'hud'; text: string; ts: number }, delivery?: RunEventExtras): RunEventRef | null {
  demo?.emit(e);
  if (!runs.current() || !session) return null;
  const st = session.state();
  return runs.event(e, { ...delivery, frame: frames.latest(), mode: st.mode, task: st.task?.id ?? null });
}

const status = (text: string) => void emit({ type: 'status', ts: Date.now(), text });

function stopProducer(): void {
  if (producer) {
    producer.stop();
    producer = null;
  }
}

// Pause Gemini for this session and cancel anything mid-request.
function pauseGemini(reason: string): void {
  session?.setPaused(true);
  abortInFlightGemini(reason);
  demo?.update({ active: false });
  runs.end('stopped');
}

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  haltGemini(`the demo was stopped (${reason})`);
  runs.end('shutdown');
  session?.setPaused(true);
  stopProducer();
  if (rtmpUp) stopRtmpServer();
  if (heartbeat) clearInterval(heartbeat);
  status(`Stopped (${reason}). Gemini is off and the demo has shut down.`);
  console.log(`\n[drive-core] stopped (${reason}) — Gemini halted, video sources closed, exiting.`);
  setTimeout(() => {
    demo?.stop();
    process.exit(0);
  }, 250);
}

process.on('SIGINT', () => shutdown('Ctrl-C'));
process.on('SIGTERM', () => shutdown('terminated'));
process.on('SIGHUP', () => shutdown('terminal closed'));
process.on('uncaughtException', (e) => {
  console.error('[drive-core] crashed:', e instanceof Error ? e.message : e);
  shutdown('crash');
});

configureGeminiGuard({
  maxPerMinute: config.geminiMaxCallsPerMinute,
  maxPerRun: config.geminiMaxCallsPerRun,
  onHalt: (reason) => {
    pauseGemini('runaway guard');
    status(`Gemini turned off automatically: ${reason}. Restart the demo to use it again.`);
    console.warn(`[drive-core] Gemini turned off by the runaway guard: ${reason}`);
  },
});

// Sample clips the in-page picker offers, discovered from the working dir and
// the repo root, plus any file passed on the CLI.
function discoverClips(explicit?: string): { id: string; name: string; path: string }[] {
  const exts = new Set(['.mov', '.mp4', '.webm', '.mkv', '.m4v']);
  const byId = new Map<string, { id: string; name: string; path: string }>();
  const add = (p: string) => {
    const id = basename(p);
    if (!byId.has(id)) byId.set(id, { id, name: id, path: p });
  };
  for (const dir of [process.cwd(), resolve(process.cwd(), '..')]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) if (exts.has(extname(f).toLowerCase())) add(resolve(dir, f));
  }
  if (explicit) {
    const p = resolve(explicit);
    if (existsSync(p)) add(p);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const clips = discoverClips(videoFile);

// ---- toolkit + session wiring -------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The demo speaker sink: every chunk becomes an 'assistant' event (the page
// plays it through /tts) and the console shows it; delivery time is
// approximated from words/rate so inter-chunk pauses land roughly right.
// The page fetches each line's clip itself (speechFor, below); this remembers
// which line of the take a text belongs to so the clip can be saved with it.
const spokenLines = new Map<string, RunEventRef>();
const sink: SpeakerSink = {
  async speak(text, meta) {
    const rate = meta.speakOptions.voice_settings?.speed ?? 1;
    const line = emit(
      { type: 'assistant', text, ts: Date.now() },
      { slower: meta.slower, rate, deliveryMode: meta.render.delivery.mode },
    );
    if (line) spokenLines.set(text, line);
    console.log(`\n🔊 SPEAK${meta.slower ? ' (slower)' : ''} [${rate.toFixed(2)}×]: ${text}\n> `);
    const words = text.split(/\s+/).length;
    await sleep(Math.min(12_000, Math.round(((words / 2.8) * 1000) / rate)));
  },
};

const tk: GuideToolkit = await bootToolkit({
  dataDir: config.appDataDir,
  actingUser: config.actingUser,
});

const speaker = createSpeaker(sink, undefined, {
  mapOpts: { filmMode: config.filmMode, voiceId: config.elevenVoiceId },
});

const vision = new VisionClient(config.geminiApiKey, config.visionModel);

const sessionDeps: SessionDeps = {
  frames,
  speaker,
  makeEngine: (si) =>
    createConversation({
      apiKey: config.geminiApiKey,
      model: config.visionModel,
      systemInstruction: si,
      temperature: config.llmTemperature,
    }),
  tk,
  panel: { emit: (e) => void emit(e) },
  tasks: TASKS,
  vision,
  initialMode: config.guideMode,
};
session = createSession(sessionDeps);
session.setPaused(true); // the page's Start switch begins

// The page asks for audio once per spoken line, and every open tab asks on
// its own; an identical line (a repeat, a second tab) reuses the clip rather
// than paying for it again.
const ttsCache = new Map<string, Promise<{ audio: Uint8Array; mime: string } | null>>();
function speechFor(text: string): Promise<{ audio: Uint8Array; mime: string } | null> {
  const stylePrefix = styleLine(session!.render());
  const key = `${config.ttsVoice}|${stylePrefix}|${text}`;
  const cached = ttsCache.get(key);
  if (cached) return cached;
  const pending = synthesizeSpeech({
    apiKey: config.geminiApiKey,
    model: config.ttsModel,
    voice: config.ttsVoice,
    text,
    stylePrefix,
  }).then((out) => {
    if (!out) ttsCache.delete(key); // don't cache failures
    return out ? { audio: out.wav, mime: out.mime } : null;
  });
  ttsCache.set(key, pending);
  if (ttsCache.size > 40) ttsCache.delete(ttsCache.keys().next().value!);
  return pending;
}

// ---- video sources --------------------------------------------------------

async function selectSource(sel: SourceSelection): Promise<void> {
  pauseGemini('source changed');
  stopProducer();
  frames.clear();
  currentClipId = undefined;
  if (sel.kind === 'file') {
    const clip = clips.find((c) => c.id === sel.clipId) ?? clips[0];
    if (!clip) {
      console.warn('[drive-core] no clip available to play');
      return;
    }
    currentClipId = clip.id;
    producer = startFileFrameCapture({
      file: clip.path,
      captureFps: config.captureFps,
      onFrame: (jpeg) => frames.push(jpeg),
    });
  } else if (sel.kind === 'rtmp') {
    if (!rtmpUp) {
      startRtmpServer(config.rtmpPort);
      rtmpUp = true;
    }
    producer = startFrameCapture({
      rtmpPort: config.rtmpPort,
      captureFps: config.captureFps,
      onFrame: (jpeg) => frames.push(jpeg),
    });
  }
  // webcam: the browser pushes frames to /frame. none: no producer — blank feed.
  demo?.update({ source: sel.kind, currentClipId });
  status(
    sel.kind === 'none'
      ? 'Source cleared — screen blank'
      : `Source → ${sel.kind === 'file' ? `clip: ${currentClipId}` : sel.kind === 'webcam' ? 'webcam' : 'smartglass stream'} · press Start to run`,
  );
  console.log(`[drive-core] source -> ${sel.kind}${currentClipId ? ` (${currentClipId})` : ''}`);
}

const initialSource: DemoSource = videoFile ? 'file' : browserCam ? 'webcam' : rtmpFlag ? 'rtmp' : 'none';

if (config.enableDemo) {
  const conflict = demoPortConflict();
  if (conflict) {
    console.warn(`[drive-core] demo view disabled: ${conflict}`);
  } else {
    demo = startDemoServer({
      port: config.demoPort,
      frames,
      source: initialSource,
      currentClipId: initialSource === 'file' ? (videoFile ? basename(videoFile) : clips[0]?.id) : undefined,
      sourceCatalog: { clips: clips.map((c) => ({ id: c.id, name: c.name })), webcam: true, rtmp: true },
      onSetSource: (sel) => selectSource(sel),
      onSay: (t) => void session!.onUtterance(t),
      sessionState: () => session!.state(),
      onSetMode: (m) => session!.setMode(m),
      // The profile editor writes to the same store handle the session reads.
      profile: { toolkit: () => tk, onProfileChanged: () => session!.refreshProfile() },
      onSetActive: (active) => {
        if (active && geminiHaltReason()) {
          demo?.update({ active: false });
          status(`Gemini is off (${geminiHaltReason()}). Restart the demo — bun run demo — to use it again.`);
          return;
        }
        if (active) {
          spokenLines.clear();
          runs.start({ source: 'demo', mode: session!.state().mode });
          session!.setPaused(false);
        } else pauseGemini('paused');
      },
      // The laptop voice approximates the render with a Gemini style line
      // (docs/DESIGN.md §5.1 layer 2) — the rehearsal stand-in for ElevenLabs.
      tts: (text) =>
        speechFor(text).then((out) => {
          const line = spokenLines.get(text);
          if (line && out) runs.attachAudio(line, out.audio);
          spokenLines.delete(text);
          return out;
        }),
      onShutdown: () => shutdown('Stop button'),
      onPagesClosed: () => {
        pauseGemini('page closed');
        status('The demo page was closed — Gemini paused. Open it and flip the switch to continue.');
        console.log('[drive-core] every demo page closed — Gemini paused');
      },
      pagesClosedGraceMs: config.pauseWhenPagesClosedSec * 1000,
      onIdle: () => {
        pauseGemini('idle');
        status(`No clicks or typing for ${config.autoPauseIdleMin} minutes — Gemini paused. Flip the switch to continue.`);
        console.log(`[drive-core] idle for ${config.autoPauseIdleMin} min — Gemini paused`);
      },
      idleMs: config.autoPauseIdleMin * 60_000,
      acceptBrowserCam: true,
      streamFps: config.demoStreamFps,
    });
  }
}

// Boot mode (toolkit mode reads the profile here) — not awaited, so the
// readline + server come up.
void session.setMode(config.guideMode);

// Start STOPPED (no Gemini): begin on the preselected source (if any) — which
// itself pauses — otherwise just wait for the page's source picker.
if (initialSource !== 'none') {
  await selectSource({
    kind: initialSource as SourceSelection['kind'],
    clipId: initialSource === 'file' ? (videoFile ? basename(videoFile) : clips[0]?.id) : undefined,
  });
}

console.log('\n[drive-core] running.');
if (initialSource === 'none') {
  console.log(`[drive-core] pick a video source in the demo view (${clips.length} clip(s) found, or webcam / smartglass stream).`);
}
if (demo) console.log(`[drive-core] demo view: http://localhost:${config.demoPort}`);
console.log(`[drive-core] mode=${config.guideMode} data=${config.appDataDir} user=${config.actingUser}`);
console.log('[drive-core] TO STOP: the ■ Stop button on the page, Ctrl-C here, or `bun run stop` in any terminal.');
console.log(
  `[drive-core] safety nets: closing the page pauses Gemini; ${config.autoPauseIdleMin} min without clicks or typing pauses it; ` +
    `more than ${config.geminiMaxCallsPerMinute} Gemini requests a minute turns it off.`,
);
console.log('[drive-core] type an utterance (here or in the demo view) and press enter.\n');

// Periodic frame heartbeat so you can see capture working.
heartbeat = setInterval(() => {
  if (frames.size) console.log(`[drive-core] frames buffered: ${frames.size}`);
}, 5000);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.prompt();
rl.on('line', (line) => {
  const text = line.trim();
  if (text) void session!.onUtterance(text);
  rl.prompt();
});
rl.on('SIGINT', () => shutdown('Ctrl-C'));
rl.on('close', () => shutdown('terminal input closed'));
