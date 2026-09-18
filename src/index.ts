// Glasses entry. Wires the glasses (camera, mic, speaker) to the
// Mentra-agnostic core through the phone app in phone/, which holds the
// Bluetooth link (Mentra Bluetooth SDK) and dials in to this server.
//
// Boot:     local RTMP server + ffmpeg frame capture + the phone bridge.
// onLink:   a phone connected — build the guide session, turn what the wearer
//           says into text (engine/stt.ts), speak through the glasses with the
//           render's style, and ask the glasses to publish their camera to our
//           RTMP.
//
// Run the whole core WITHOUT this file (no phone, no glasses) via
// `bun run demo` (src/scripts/drive-core.ts).
//
// Stopping: Ctrl-C, SIGTERM (`bun run stop`) or the local demo page's ■ Stop
// halt Gemini first, stop the glasses camera and exit. The Start switch (phone
// app or /webview panel) pauses Gemini, the camera and the mic together and
// cancels anything mid-request. The runaway guard (engine/gemini-rest.ts)
// pauses the session and turns Gemini off if requests pile up.

import { config, demoPortConflict, requireBridgeToken } from './config.ts';
import { FrameStore, startFrameCapture } from './transport/frames.ts';
import { getPublishUrl, startRtmpServer, stopRtmpServer } from './transport/rtmp.ts';
import { startDemoServer, type DemoServerHandle } from './transport/demo-server.ts';
import { mountWebview, type WebviewHandle } from './transport/webview.ts';
import { mountRuns } from './transport/runs-web.ts';
import { createPhoneBridge, type PhoneLink } from './transport/phone-bridge.ts';
import type { PanelState } from './transport/phone-protocol.ts';
import { pcmToWav, synthesizeSpeech, toAac } from './engine/tts.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSegmenter, MIC_SAMPLE_RATE, transcribe } from './engine/stt.ts';
import { chunkText } from './toolkit-candidates/adapters/paced-delivery.ts';
import { VisionClient } from './engine/vision.ts';
import { createConversation } from './engine/request-engine.ts';
import { abortInFlightGemini, configureGeminiGuard, geminiHaltReason, haltGemini } from './engine/gemini-rest.ts';
import { createSpeaker, type SpeakerSink } from './audio/speaker.ts';
import { styleLine } from './toolkit-candidates/adapters/voice.ts';
import { bootToolkit, type GuideToolkit } from './toolkit/host.ts';
import { createSession, type Session, type SessionDeps } from './runtime/session.ts';
import { createRunRecorder, type RunEventExtras, type RunEventRef } from './runtime/run-recorder.ts';
import type { Task } from './skills/types.ts';
import washingMachine from './tasks/washing-machine.json';
import bill from './tasks/bill.json';

const bridgeToken = requireBridgeToken();

const TASKS: Task[] = [washingMachine as Task, bill as Task];

// Shared, app-wide frame store: ffmpeg fills it, the session reads it.
const frames = new FrameStore(config.frameRingSize);
let captureHandle: { stop: () => void } | null = null;

// Past runs: every Start→Stop take is kept on disk for /webview/runs. Shared
// across phones like the frame store; a run a crash left open is closed here.
const runs = createRunRecorder({ dir: config.runsDir, keep: config.runsKeep });
runs.recover();

// One demo browser view + one phone panel for the whole app (phones come and
// go; the URLs stay stable). onLink repoints them at the live session.
let demo: DemoServerHandle | null = null;
let webview: WebviewHandle;

function startTransport(): void {
  if (!config.enableRtmpStream || !config.useLocalRtmp) {
    console.log('[wearable] RTMP disabled (ENABLE_RTMP_STREAM/USE_LOCAL_RTMP)');
    return;
  }
  startRtmpServer(config.rtmpPort);
  captureHandle = startFrameCapture({
    rtmpPort: config.rtmpPort,
    captureFps: config.captureFps,
    onFrame: (jpeg) => frames.push(jpeg),
  });
}

// Everything that lives as long as one phone connection.
interface Live {
  link: PhoneLink;
  session: Session;
  tk: GuideToolkit; // the store this session reads — the profile editor writes to the same handle
  setActive: (on: boolean) => void;
  setMode: (mode: 'baseline' | 'toolkit') => void;
  hear: (text: string) => void;
  onGlasses: () => void;
  onMicAudio: (pcm: Buffer) => void;
  teardown: () => void;
}
let live: Live | null = null;

const CAMERA_RETRIES = 5;
const CAMERA_RETRY_DELAY_MS = 5000;

async function buildLive(link: PhoneLink): Promise<Live> {
  let sessionActive = false;
  let speaking = 0;
  let thinking = 0;
  let heard = '';
  let lastLine = '';
  let status = 'Ready — press Start to begin';
  let gone = false;
  // The take this phone started, so a stale session never ends a newer one.
  let runId: string | null = null;

  const pushState = (): void => {
    const state: PanelState = {
      active: sessionActive,
      mode: guideSession.state().mode,
      phase: !sessionActive ? 'idle' : speaking > 0 ? 'speaking' : thinking > 0 ? 'thinking' : 'listening',
      heard,
      lastLine,
      status,
      geminiOff: geminiHaltReason(),
    };
    link.sendState(state);
  };
  const setStatus = (text: string): void => {
    status = text;
    console.log(`[wearable] ${text}`);
    emit({ type: 'status', text, ts: Date.now() });
    pushState();
  };
  const emit = (
    e: { type: 'user' | 'assistant' | 'status' | 'hud'; text: string; ts: number },
    delivery?: RunEventExtras,
  ): RunEventRef | null => {
    demo?.emit(e);
    webview.emit(e);
    if (e.type === 'user') {
      heard = e.text;
      pushState();
    }
    if (!runId || runs.current()?.id !== runId) return null;
    const st = guideSession.state();
    const ref = runs.event(e, { ...delivery, frame: frames.latest(), mode: st.mode, task: st.task?.id ?? null });
    if (e.type === 'user' && utteranceWav) {
      runs.attachAudio(ref, utteranceWav); // what the mic actually heard, for the runs page
      utteranceWav = null;
    }
    return ref;
  };
  // Everything the wearer says or taps goes through here, so the phone can
  // show "thinking" for as long as the guide is working on it.
  const hear = (text: string): void => {
    thinking++;
    pushState();
    void Promise.resolve(guideSession.onUtterance(text))
      .catch((e) => console.error('[wearable] turn failed:', e instanceof Error ? e.message : e))
      .finally(() => {
        thinking--;
        pushState();
      });
  };

  // The glasses speaker sink: Gemini TTS steered by the render's style line,
  // played by the phone, which routes it to the glasses. The mic is ignored
  // while a line plays so the guide never hears itself.
  //
  // Speed: Gemini TTS takes seconds per line, and a stepwise answer is many
  // lines. So every line of an answer is synthesized at once, ahead of its
  // turn (prepare), and a long single line is cut into sentences that are
  // synthesized in parallel and joined back into one clip — the first words
  // arrive sooner either way.
  const clips = new Map<string, Promise<Buffer | null>>();
  const synthOne = (text: string, style: string): Promise<Buffer | null> => {
    const key = `${style}\u0000${text}`;
    let p = clips.get(key);
    if (!p) {
      const t0 = Date.now();
      p = synthesizeSpeech({ apiKey: config.geminiApiKey, model: config.ttsModel, voice: config.ttsVoice, text, stylePrefix: style }).then((out) => {
        console.log(`[tts] ${((Date.now() - t0) / 1000).toFixed(1)}s for ${text.split(/\s+/).length} words`);
        return out ? out.wav : null;
      });
      clips.set(key, p);
      setTimeout(() => clips.delete(key), 120_000);
    }
    return p;
  };
  const LONG_LINE_WORDS = 24;
  const synth = (text: string, style: string): Promise<Buffer | null> => {
    const parts = chunkText(text, LONG_LINE_WORDS);
    if (parts.length <= 1) return synthOne(text, style);
    return Promise.all(parts.map((part) => synthOne(part, style))).then((wavs) => (wavs.every(Boolean) ? joinWavs(wavs as Buffer[]) : null));
  };
  const sink: SpeakerSink = {
    prepare(chunks, meta) {
      const style = styleLine(meta.render, { slower: meta.slower });
      for (const chunk of chunks) void synth(chunk, style);
    },
    async speak(text, meta) {
      const line = emit(
        { type: 'assistant', text, ts: Date.now() },
        {
          slower: meta.slower,
          rate: meta.speakOptions.voice_settings?.speed ?? meta.render.speech.rate,
          deliveryMode: meta.render.delivery.mode,
        },
      );
      if (gone || !sessionActive) return;
      lastLine = text;
      pushState();
      const wav = await Promise.race([
        synth(text, styleLine(meta.render, { slower: meta.slower })),
        new Promise<null>((r) => setTimeout(() => r(null), config.ttsDeadlineMs)),
      ]);
      if (!wav) console.warn(`[tts] no clip within ${config.ttsDeadlineMs / 1000}s — the phone reads this line itself`);
      const out = wav ? { wav } : null;
      if (gone || !sessionActive) return;
      runs.attachAudio(line, out?.wav);
      const clip = out ? await toAac(out.wav) : null;
      if (gone || !sessionActive) return; // Stop pressed while encoding
      speaking++;
      segmenter.reset();
      pushState();
      try {
        await link.speak(text, clip);
      } catch (e) {
        console.error('[wearable] speak failed:', e instanceof Error ? e.message : e);
      } finally {
        speaking--;
        segmenter.reset();
        pushState();
      }
    },
  };

  // A fixed line, spoken outside the guide's own turn-taking (mic held off
  // while it plays, like any other line).
  const sayCanned = async (text: string): Promise<void> => {
    const clip = await cannedClip(text, styleLine(guideSession.render(), { slower: false }));
    if (gone || !sessionActive) return;
    lastLine = text;
    speaking++;
    segmenter.reset();
    pushState();
    try {
      await link.speak(text, clip);
    } catch (e) {
      console.error('[wearable] canned line failed:', e instanceof Error ? e.message : e);
    } finally {
      speaking--;
      segmenter.reset();
      pushState();
    }
  };

  const tk: GuideToolkit = await bootToolkit({
    dataDir: config.appDataDir,
    actingUser: config.actingUser,
  });

  const speaker = createSpeaker(sink, undefined, {
    mapOpts: { filmMode: config.filmMode, voiceId: config.elevenVoiceId },
  });

  const sessionDeps: SessionDeps = {
    frames,
    speaker,
    makeEngine: (si) =>
      createConversation({
        apiKey: config.geminiApiKey,
        model: config.visionModel,
        systemInstruction: si,
        temperature: config.llmTemperature,
        // Overlap: as the reply streams in, every sentence that is already
        // complete (and not the last, which may still be growing) is cut the
        // way the speaker will cut it and sent to TTS now. When the speaker
        // asks for those same lines a moment later they are already made.
        onPartial: (soFar) => {
          const render = guideSession.render();
          const style = styleLine(render, { slower: false });
          const chunks = chunkText(soFar, render.delivery.maxWordsPerUtterance ?? LONG_LINE_WORDS);
          for (const chunk of chunks.slice(0, -1)) if (/[.!?…]["'”)]?$/.test(chunk)) void synth(chunk, style);
        },
      }),
    tk,
    panel: { emit },
    tasks: TASKS,
    vision: new VisionClient(config.geminiApiKey, config.visionModel),
    initialMode: config.guideMode,
  };
  const guideSession = createSession(sessionDeps);
  guideSession.setPaused(true);

  // ── Mic -> text -> session ───────────────────────────────────────────────
  // Turn-taking: the guide listens, then works, then speaks — and only listens
  // again once it has finished. Anything the mic hears while a turn is being
  // worked on (the wearer still talking, the thinking sound, a second copy of
  // the same sentence) is dropped rather than queued as another request.
  let utteranceWav: Buffer | null = null;
  const transcribeNow = (pcm: Buffer): Promise<string> => transcribe({ apiKey: config.geminiApiKey, model: config.sttModel, pcm });
  // Overlap: transcription starts on the first guess that the person has
  // finished (a short silence) and is simply reused if the guess holds when
  // the full silence timer runs out — the answer is that much sooner. If they
  // go on talking the guess is dropped and the finished utterance is
  // transcribed on its own.
  let early: Promise<string> | null = null;
  const segmenter = createSegmenter(
    {
      onTentative: (pcm) => {
        if (sessionActive && speaking === 0 && thinking === 0) early = transcribeNow(pcm);
      },
      onTentativeWithdrawn: () => {
        early = null;
      },
      onUtterance: (pcm, tentativeHeld) => {
        const secs = (pcm.length / 32_000).toFixed(1);
        const reuse = tentativeHeld ? early : null;
        early = null;
        if (!sessionActive || speaking > 0 || thinking > 0) return void console.log(`[stt] ${secs}s utterance dropped — the guide was busy`);
        console.log(`[stt] ${secs}s utterance${reuse ? ' (transcription already under way)' : ''}`);
        thinking++;
        pushState();
        void (reuse ?? transcribeNow(pcm)).then((text) => {
          thinking--;
          if (text && sessionActive && !gone) {
            utteranceWav = pcmToWav(pcm, MIC_SAMPLE_RATE); // kept with the turn in the run (emit)
            hear(text);
          } else pushState();
        });
      },
    },
    { tentativeSilenceMs: 450 },
  );

  // Mic health, once every ten seconds of a take: a steady 32 kB/s is one clean
  // 16 kHz stream; a multiple of that means the phone is sending copies.
  let micBytes = 0;
  let micSince = Date.now();
  const meterMic = (n: number): void => {
    micBytes += n;
    const ms = Date.now() - micSince;
    if (ms < 10_000) return;
    console.log(`[mic] ${(micBytes / ms).toFixed(1)} kB/s (one clean stream is 32.0)`);
    micBytes = 0;
    micSince = Date.now();
  };

  // ── Camera + Start/Stop lifecycle ────────────────────────────────────────
  // ONE switch controls Gemini, the glasses camera and the mic. Camera RTMP
  // needs the glasses on Wi-Fi, so it (re)starts when they get there.
  let cameraStarted = false;
  // A start that is still being answered. The glasses run a single stream and
  // a second request cancels the first, so a Wi-Fi blip mid-start must wait.
  let cameraStarting = false;
  const startCamera = async (): Promise<void> => {
    if (cameraStarted || cameraStarting || !sessionActive) return;
    if (!link.glasses.connected) return setStatus('Connect the glasses in the phone app');
    if (link.glasses.wifi === false) return setStatus('Connect the glasses to Wi-Fi to enable the live camera');
    cameraStarted = true;
    cameraStarting = true;
    const url = getPublishUrl(config.rtmpHost, config.rtmpPort);
    try {
      return await tryStartCamera(url);
    } finally {
      cameraStarting = false;
    }
  };
  const tryStartCamera = async (url: string): Promise<void> => {
    for (let attempt = 1; attempt <= CAMERA_RETRIES; attempt++) {
      try {
        await link.startCamera(url, { fps: config.frameRate, width: config.streamWidth, height: config.streamHeight, bitrate: config.streamBitrate });
        if (!sessionActive || gone) return void link.stopCamera();
        return setStatus('Ready — Wearable Task Guide listening');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[wearable] camera attempt ${attempt}/${CAMERA_RETRIES} failed: ${msg}`);
        if (gone || !sessionActive || !link.glasses.connected) break;
        if (attempt < CAMERA_RETRIES) await new Promise((r) => setTimeout(r, CAMERA_RETRY_DELAY_MS));
        else setStatus(`Camera stream failed: ${msg}`);
      }
    }
    cameraStarted = false;
  };
  const stopCamera = (): void => {
    if (cameraStarted) link.stopCamera();
    cameraStarted = false;
  };
  const setActive = (on: boolean): void => {
    if (on && geminiHaltReason()) {
      webview.update({ active: false });
      console.warn(`[wearable] Start refused — Gemini is off (${geminiHaltReason()})`);
      return setStatus('Gemini is off — restart the server app to use it');
    }
    sessionActive = on;
    webview.update({ active: on });
    guideSession.setPaused(!on);
    segmenter.reset();
    link.setMic(on);
    if (on) {
      runId = runs.start({ source: 'glasses', mode: guideSession.state().mode })?.id ?? null;
      setStatus('Starting…');
      void sayCanned('Starting now.');
      void startCamera();
    } else {
      abortInFlightGemini('paused');
      link.stopAudio();
      stopCamera();
      setStatus('Stopped — camera + AI off');
      if (runId) runs.end('stopped', runId);
      runId = null;
    }
  };

  const setMode = (m: 'baseline' | 'toolkit'): Promise<void> => Promise.resolve(guideSession.setMode(m)).then(pushState);

  // Point the panels at this live session.
  const controls = {
    onSay: hear,
    onSetActive: setActive,
    onSetMode: setMode,
  };
  demo?.update(controls);
  webview.update(controls);

  // Boot mode (toolkit mode reads the profile here). Then the fixed opening
  // line is made ready, so the first Start is as quick as every later one.
  void setMode(config.guideMode).then(() => void cannedClip('Starting now.', styleLine(guideSession.render(), { slower: false })));

  return {
    link,
    session: guideSession,
    tk,
    setActive,
    setMode: (m) => void setMode(m),
    hear,
    onGlasses: () => {
      if (!link.glasses.connected || link.glasses.wifi === false) {
        if (cameraStarted) console.log('[wearable] glasses dropped off — stopping camera');
        cameraStarted = false;
        if (sessionActive) void startCamera(); // sets the "connect…" status
      } else if (sessionActive) {
        void startCamera();
      }
    },
    onMicAudio: (pcm) => {
      if (!sessionActive) return;
      meterMic(pcm.length);
      if (speaking === 0 && thinking === 0) segmenter.push(pcm);
      else segmenter.reset();
    },
    teardown: () => {
      gone = true;
      sessionActive = false;
      abortInFlightGemini('phone disconnected');
      guideSession.setPaused(true);
      if (runId) runs.end('disconnected', runId);
      runId = null;
      webview.update({ active: false, onSay: () => {} });
      demo?.update({ onSay: () => {} });
    },
  };
}

// Turn Gemini, the glasses camera and the mic off.
function pauseEverything(reason: string): void {
  abortInFlightGemini(reason);
  live?.setActive(false);
  webview?.update({ active: false });
}

// Building a session takes a moment (the toolkit store opens), and a phone
// sends its first controls straight after connecting — so everything a phone
// says waits for its session rather than being dropped.
let building: { link: PhoneLink; ready: Promise<Live | null> } | null = null;
function withLive(link: PhoneLink, fn: (l: Live) => void): void {
  if (live?.link === link) return fn(live);
  if (building?.link === link) void building.ready.then((l) => l && live === l && fn(l));
}

const bridge = createPhoneBridge({
  token: bridgeToken,
  handlers: {
    onLink: (link) => {
      live?.teardown();
      live = null;
      const ready = buildLive(link).then(
        (l) => {
          if (building?.link !== link) return l.teardown(), null; // it left, or a newer phone took over
          building = null;
          live = l;
          return l;
        },
        (e) => {
          console.error('[wearable] could not start a session:', e instanceof Error ? e.message : e);
          return null;
        },
      );
      building = { link, ready };
    },
    onUnlink: (link) => {
      if (building?.link === link) building = null;
      if (live?.link !== link) return;
      live.teardown();
      live = null;
    },
    onGlasses: (link) => withLive(link, (l) => l.onGlasses()),
    onMicAudio: (link, pcm) => {
      if (live?.link === link) live.onMicAudio(pcm);
    },
    onSetActive: (link, on) => withLive(link, (l) => l.setActive(on)),
    onSetMode: (link, mode) => withLive(link, (l) => l.setMode(mode)),
    onSay: (link, text) => withLive(link, (l) => l.hear(text)),
  },
});

bridge.app.get('/debug/frame', (_req, res) => {
  const jpeg = frames.latest();
  if (!jpeg) return void res.status(404).send('No frame yet');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(jpeg);
});

webview = mountWebview({
  app: bridge.app,
  frames,
  source: 'glasses',
  sessionState: () => live?.session.state() ?? emptyState(),
  tts: async (text) => {
    const out = await synthesizeSpeech({
      apiKey: config.geminiApiKey,
      model: config.ttsModel,
      voice: config.ttsVoice,
      text,
      stylePrefix: live ? styleLine(live.session.render()) : '',
    });
    return out ? { audio: out.wav, mime: out.mime } : null;
  },
  streamFps: config.demoStreamFps,
  runsEnabled: !!config.adminPassword,
  profile: { toolkit: () => live?.tk ?? null, onProfileChanged: () => live?.session.refreshProfile() },
});
mountRuns({ app: bridge.app, recorder: runs, password: config.adminPassword });

// Fixed lines the guide says every take ("Starting now.") are made once and
// kept on disk, so after the first time they play the instant they are asked
// for — no Gemini round trip.
const CANNED_DIR = join(config.appDataDir, '..', '.tts-cache');
const canned = new Map<string, Promise<{ audio: Buffer; mime: string; ext: string } | null>>();
function cannedClip(text: string, style: string): Promise<{ audio: Buffer; mime: string; ext: string } | null> {
  const key = createHash('sha1').update(`${config.ttsVoice}|${style}|${text}`).digest('hex');
  let p = canned.get(key);
  if (p) return p;
  p = (async () => {
    const file = join(CANNED_DIR, `${key}.aac`);
    if (existsSync(file)) return { audio: readFileSync(file), mime: 'audio/aac', ext: 'aac' };
    const out = await synthesizeSpeech({ apiKey: config.geminiApiKey, model: config.ttsModel, voice: config.ttsVoice, text, stylePrefix: style });
    if (!out) return null;
    const clip = await toAac(out.wav);
    if (clip.ext === 'aac') {
      try {
        mkdirSync(CANNED_DIR, { recursive: true });
        writeFileSync(file, clip.audio);
      } catch (e) {
        console.warn('[tts] could not keep a canned line on disk:', e instanceof Error ? e.message : e);
      }
    }
    return clip;
  })();
  canned.set(key, p);
  p.then((c) => c || canned.delete(key)).catch(() => canned.delete(key));
  return p;
}

// Several TTS clips → one. They share a format (tts.ts wraps Gemini's PCM in a
// 44-byte header), so it is the first header with the summed length over the
// concatenated samples.
function joinWavs(wavs: Buffer[]): Buffer {
  if (wavs.length === 1) return wavs[0]!;
  const sampleRate = wavs[0]!.readUInt32LE(24);
  return pcmToWav(Buffer.concat(wavs.map((w) => w.subarray(44))), sampleRate);
}

function emptyState() {
  return {
    mode: config.guideMode,
    profileOn: false,
    needs: [],
    captionsMirror: false,
    rate: 1,
    deliveryMode: 'continuous' as const,
    task: null,
    paused: true,
    switching: false,
  };
}

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  haltGemini(`the app was stopped (${reason})`);
  runs.end('shutdown');
  pauseEverything(reason);
  bridge.close();
  captureHandle?.stop();
  stopRtmpServer();
  demo?.stop();
  console.log(`[wearable] stopped (${reason}) — Gemini halted, cameras off, exiting.`);
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', () => shutdown('Ctrl-C'));
process.on('SIGTERM', () => shutdown('terminated'));
process.on('SIGHUP', () => shutdown('terminal closed'));
process.on('uncaughtException', (e) => {
  console.error('[wearable] crashed:', e instanceof Error ? e.message : e);
  shutdown('crash');
});

configureGeminiGuard({
  maxPerMinute: config.geminiMaxCallsPerMinute,
  maxPerRun: config.geminiMaxCallsPerRun,
  onHalt: (reason) => {
    console.warn(`[wearable] Gemini turned off by the runaway guard: ${reason}`);
    pauseEverything('runaway guard');
  },
});

function startDemo(): void {
  if (!config.enableDemo) return;
  const conflict = demoPortConflict();
  if (conflict) {
    console.warn(`[wearable] demo view disabled: ${conflict}`);
    return;
  }
  demo = startDemoServer({
    port: config.demoPort,
    frames,
    source: 'glasses',
    onSay: () => {}, // no live session yet; onSession repoints
    sessionState: () => live?.session.state() ?? emptyState(),
    tts: async (text) => {
      const out = await synthesizeSpeech({
        apiKey: config.geminiApiKey,
        model: config.ttsModel,
        voice: config.ttsVoice,
        text,
        stylePrefix: live ? styleLine(live.session.render()) : '',
      });
      return out ? { audio: out.wav, mime: out.mime } : null;
    },
    onShutdown: () => shutdown('Stop button'),
    profile: { toolkit: () => live?.tk ?? null, onProfileChanged: () => live?.session.refreshProfile() },
    streamFps: config.demoStreamFps,
  });
}

// Boot order: generic transport (RTMP + frame capture) and the standalone
// demo, THEN the phone bridge — it binds PORT and serves /phone and /webview.
(async () => {
  startTransport();
  startDemo();
  await bridge.listen(config.port);
  console.log(`[wearable] waiting for the phone app on :${config.port} (mode=${config.guideMode})`);
  console.log('[wearable] TO STOP: Ctrl-C here, `bun run stop` in any terminal, or ■ Stop on the local demo page.');
})().catch((e) => {
  console.error('[wearable] failed to start:', e);
  process.exit(1);
});
