// MentraOS app entry. This is the only place AppServer is instantiated; it
// wires the glasses (camera/mic/speaker/HUD) to the Mentra-agnostic core.
//
// Boot:        local RTMP server + ffmpeg frame capture + toolkit store.
// onSession:   build the guide session, route transcripts in, speak (WITH
//              the render's ElevenLabs SpeakOptions) + HUD out, and ask the
//              glasses to publish their camera to our RTMP.
//
// Run the whole core WITHOUT this file (no Mentra, no glasses) via
// `bun run demo` (src/scripts/drive-core.ts).
//
// Stopping: Ctrl-C, SIGTERM (`bun run stop`) or the local demo page's ■ Stop
// halt Gemini first, stop every glasses camera and exit. The phone panel's
// power button pauses Gemini and the camera and cancels anything mid-request.
// The runaway guard (engine/gemini-rest.ts) pauses every session and turns
// Gemini off if requests pile up.
//
// Heavy trim from the old draft's 464-line entry: onboarding, the draft
// profile layer, adapter-agent, skill chips and the phone's active_skills
// setting are gone — the toolkit owns the profile now, and the phone panel's
// controls are mode/consent/done.

import { AppServer, type AppSession } from '@mentra/sdk';
import { config, demoPortConflict, requireMentraEnv } from './config.ts';
import { FrameStore, startFrameCapture } from './transport/frames.ts';
import { startRtmpServer, stopRtmpServer } from './transport/rtmp.ts';
import { startDemoServer, type DemoServerHandle } from './transport/demo-server.ts';
import { mountWebview, type WebviewHandle } from './transport/webview.ts';
import { synthesizeSpeech } from './engine/tts.ts';
import { VisionClient } from './engine/vision.ts';
import { createConversation } from './engine/request-engine.ts';
import { abortInFlightGemini, configureGeminiGuard, geminiHaltReason, haltGemini } from './engine/gemini-rest.ts';
import { onFinalTranscript, showText, speak, startCameraStream } from './transport/mentra-io.ts';
import { createSpeaker, type SpeakerSink } from './audio/speaker.ts';
import { styleLine } from './audio/gemini-style.ts';
import { audioConsent } from './toolkit/consent-audio.ts';
import { bootToolkit, type GuideToolkit } from './toolkit/host.ts';
import { createSession, type Session, type SessionDeps } from './runtime/session.ts';
import type { Task } from './skills/types.ts';
import washingMachine from './tasks/washing-machine.json';
import bill from './tasks/bill.json';

const { packageName, apiKey } = requireMentraEnv();

const TASKS: Task[] = [washingMachine as Task, bill as Task];

// Shared, app-wide frame store: ffmpeg fills it, sessions read it.
const frames = new FrameStore(config.frameRingSize);
let captureHandle: { stop: () => void } | null = null;

// One demo browser view + one phone webview for the whole app (sessions come
// and go; the URLs stay stable). onSession repoints them at the live session.
let demo: DemoServerHandle | null = null;

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

class GuideApp extends AppServer {
  private sessions = new Map<string, Session>();
  private streamHandles = new Map<string, { stop: () => void }>();
  private transcriptCleanups = new Map<string, () => void>();
  private cameraWatchers = new Map<string, () => void>();
  private settingsCleanups = new Map<string, Array<() => void>>();
  // Per-session Start/Stop switch (Gemini + camera together).
  private activeSwitches = new Map<string, (on: boolean) => void>();
  private webview: WebviewHandle;

  constructor() {
    super({ packageName, apiKey, port: config.port });

    const app = this.getExpressApp() as any;
    app.get('/debug/frame', (_req: any, res: any) => {
      const jpeg = frames.latest();
      if (!jpeg) return res.status(404).send('No frame yet');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(jpeg);
    });

    this.webview = mountWebview({
      app,
      frames,
      source: 'glasses',
      sessionState: () => this.liveSession?.state() ?? emptyState(),
      tts: async (text) => {
        const out = await synthesizeSpeech({
          apiKey: config.geminiApiKey,
          model: config.ttsModel,
          voice: config.ttsVoice,
          text,
          stylePrefix: this.liveSession ? styleLine(this.liveSession.render()) : '',
        });
        return out ? { audio: out.wav, mime: out.mime } : null;
      },
      streamFps: config.demoStreamFps,
    });
  }

  private liveSession: Session | null = null;

  // Turn Gemini and every glasses camera off, in every live session.
  pauseEverything(reason: string): void {
    abortInFlightGemini(reason);
    for (const setActive of this.activeSwitches.values()) setActive(false);
    for (const s of this.sessions.values()) s.setPaused(true);
    this.webview.update({ active: false });
  }

  protected async onSession(session: AppSession, sessionId: string): Promise<void> {
    console.log(`[wearable] session ${sessionId} started`);
    showText(session, 'Appliance Guide\nstarting…');

    const webview = this.webview;
    const emit = (e: { type: 'user' | 'assistant' | 'status' | 'hud' | 'learn'; text: string; ts: number }) => {
      demo?.emit(e);
      webview.emit(e);
    };

    // The glasses speaker sink: Mentra TTS with the render's SpeakOptions —
    // the line the old draft never had — plus the HUD mirror.
    const sink: SpeakerSink = {
      async speak(text, meta) {
        emit({ type: 'assistant', text, ts: Date.now() });
        if (meta.render.captionsMirror) showText(session, text);
        await speak(session, text, meta.speakOptions).catch((e) =>
          console.error('[wearable] speak failed:', e instanceof Error ? e.message : e),
        );
      },
    };

    let guideSession: Session | null = null;

    const consentIO = {
      speak: async (text: string) => {
        emit({ type: 'assistant', text, ts: Date.now() });
        await speak(session, text).catch(() => {});
      },
      showCard: (card: Parameters<Session['setCard']>[0]) => guideSession?.setCard(card),
      nextUtterance: (timeoutMs: number) => (guideSession ? guideSession.waitAnswer(timeoutMs) : Promise.resolve(null)),
    };

    const tk: GuideToolkit = await bootToolkit({
      dataDir: config.appDataDir,
      consent: audioConsent(consentIO),
      actingUser: config.actingUser,
    });

    const speaker = createSpeaker(sink, undefined, {
      onRepeatPattern: (info) => guideSession?.onRepeatPattern(info),
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
        }),
      tk,
      panel: { emit },
      tasks: TASKS,
      vision: new VisionClient(config.geminiApiKey, config.visionModel),
      initialMode: config.guideMode,
    };
    guideSession = createSession(sessionDeps);
    guideSession.setPaused(true);
    this.sessions.set(sessionId, guideSession);
    this.liveSession = guideSession;

    // ── Camera + Start/Stop lifecycle ──────────────────────────────────────
    // ONE switch controls BOTH Gemini and the glasses camera. Camera RTMP
    // needs WiFi, so it's gated on WiFi and (re)starts when WiFi connects.
    let sessionActive = false;
    let cameraStarted = false;
    const startCamera = async (): Promise<void> => {
      if (cameraStarted || !sessionActive) return;
      const w = (session as any).device?.state?.wifiConnected;
      if (w && w.value === false) {
        showText(session, 'Connect glasses to WiFi\nto enable the live camera');
        return;
      }
      cameraStarted = true;
      try {
        const handle = await startCameraStream(session, {
          rtmpHost: config.rtmpHost,
          rtmpPort: config.rtmpPort,
          frameRate: config.frameRate,
          onStatus: (status, detail) => console.log(`[wearable] camera: ${status}${detail ? ' — ' + detail : ''}`),
        });
        this.streamHandles.set(sessionId, handle);
        showText(session, 'Ready — Appliance Guide listening');
      } catch (e) {
        cameraStarted = false;
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[wearable] camera stream failed:', msg);
        showText(session, `Camera stream failed:\n${msg}`);
      }
    };
    const stopCamera = (): void => {
      this.streamHandles.get(sessionId)?.stop();
      this.streamHandles.delete(sessionId);
      cameraStarted = false;
    };
    const setActive = (on: boolean): void => {
      if (on && geminiHaltReason()) {
        webview.update({ active: false });
        showText(session, 'Gemini is off\nrestart the app to use it');
        console.warn(`[wearable] Start refused — Gemini is off (${geminiHaltReason()})`);
        return;
      }
      sessionActive = on;
      webview.update({ active: on });
      guideSession!.setPaused(!on);
      if (on) {
        void startCamera();
      } else {
        abortInFlightGemini('paused');
        stopCamera();
        showText(session, 'Stopped — camera + AI off');
      }
    };
    this.activeSwitches.set(sessionId, setActive);
    showText(session, 'Ready — press Start\nto begin');

    // Point the panels at this live session.
    const controls = {
      onSay: (t: string) => void guideSession!.onUtterance(t),
      onSetActive: setActive,
      onSetMode: (m: 'baseline' | 'toolkit') => guideSession!.setMode(m),
      onConsent: (r: 'accept' | 'declineOnce') => guideSession!.respondConsent(r),
    };
    demo?.update(controls);
    webview.update(controls);

    // Master control from the MentraOS phone app (app_config.json settings).
    const settings = (session as any).settings;
    if (settings) {
      const cleanups: Array<() => void> = [];
      const u1 = settings.onValueChange?.('ai_active', (v: boolean) => {
        console.log(`[wearable] ai_active -> ${v}`);
        setActive(!!v);
      });
      if (typeof u1 === 'function') cleanups.push(u1);
      this.settingsCleanups.set(sessionId, cleanups);
    }

    // Mic -> session (also the spoken consent answers).
    this.transcriptCleanups.set(
      sessionId,
      onFinalTranscript(session, (text) => void guideSession!.onUtterance(text)),
    );

    // Watch WiFi: start the camera when the glasses get on WiFi, stop on loss.
    const wifi = (session as any).device?.state?.wifiConnected;
    if (wifi) {
      const unsub = wifi.onChange((connected: boolean) => {
        if (connected) {
          console.log('[wearable] glasses WiFi connected — starting camera');
          void startCamera();
        } else {
          console.log('[wearable] glasses WiFi lost — stopping camera');
          stopCamera();
        }
      });
      if (typeof unsub === 'function') this.cameraWatchers.set(sessionId, unsub);
    }

    // Boot mode (consent beat fires here in toolkit mode with a fresh store).
    void guideSession.setMode(config.guideMode);
  }

  protected async onStop(sessionId: string): Promise<void> {
    console.log(`[wearable] session ${sessionId} stopped`);
    this.activeSwitches.get(sessionId)?.(false);
    this.activeSwitches.delete(sessionId);
    this.transcriptCleanups.get(sessionId)?.();
    this.transcriptCleanups.delete(sessionId);
    this.cameraWatchers.get(sessionId)?.();
    this.cameraWatchers.delete(sessionId);
    this.settingsCleanups.get(sessionId)?.forEach((fn) => fn());
    this.settingsCleanups.delete(sessionId);
    this.streamHandles.get(sessionId)?.stop();
    this.streamHandles.delete(sessionId);
    const s = this.sessions.get(sessionId);
    if (s) {
      s.setPaused(true);
      if (this.liveSession === s) this.liveSession = null;
    }
    this.sessions.delete(sessionId);
    demo?.update({ onSay: () => {} });
    this.webview.update({ onSay: () => {} });
  }
}

function emptyState() {
  return {
    mode: config.guideMode,
    granted: false,
    needs: [],
    captionsMirror: false,
    rate: 1,
    deliveryMode: 'continuous' as const,
    consentCard: null,
    listening: false,
    task: null,
    paused: true,
    switching: false,
  };
}

const app = new GuideApp();

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  haltGemini(`the app was stopped (${reason})`);
  app.pauseEverything(reason);
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
    app.pauseEverything('runaway guard');
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
    sessionState: () => (app as any).liveSession?.state() ?? emptyState(),
    tts: async (text) => {
      const live = (app as any).liveSession as Session | null;
      const out = await synthesizeSpeech({
        apiKey: config.geminiApiKey,
        model: config.ttsModel,
        voice: config.ttsVoice,
        text,
        stylePrefix: live ? styleLine(live.render()) : '',
      });
      return out ? { audio: out.wav, mime: out.mime } : null;
    },
    onShutdown: () => shutdown('Stop button'),
    streamFps: config.demoStreamFps,
  });
}

// Boot order: generic transport (RTMP + frame capture) and the standalone
// demo, THEN the AppServer — app.start() binds PORT and serves the /webhook
// endpoint MentraOS Cloud calls.
(async () => {
  startTransport();
  startDemo();
  await app.start();
  console.log(`[wearable] app "${packageName}" listening on :${config.port} (mode=${config.guideMode})`);
  console.log('[wearable] TO STOP: Ctrl-C here, `bun run stop` in any terminal, or ■ Stop on the local demo page.');
})().catch((e) => {
  console.error('[wearable] failed to start:', e);
  process.exit(1);
});
