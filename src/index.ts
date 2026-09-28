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
import { dropPublishersExcept, getPublishUrl, newStreamKey, startRtmpServer, stopRtmpServer } from './transport/rtmp.ts';
import { startDemoServer, type DemoServerHandle } from './transport/demo-server.ts';
import { mountWebview, type WebviewHandle } from './transport/webview.ts';
import { mountRuns } from './transport/runs-web.ts';
import { createPhoneBridge, type PhoneLink } from './transport/phone-bridge.ts';
import { brightness, loadLag, saveLag, solveLag } from './transport/camera-lag.ts';
import type { OnboardingPanel, PanelState } from './transport/phone-protocol.ts';
import { pcmToWav, synthesizeSpeech, toAac, trimSilence } from './engine/tts.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSegmenter, MIC_SAMPLE_RATE, transcribe } from './engine/stt.ts';
import { chunkText } from './toolkit-candidates/adapters/paced-delivery.ts';
import { VisionClient } from './engine/vision.ts';
import { createConversation } from './engine/request-engine.ts';
import { abortInFlightGemini, configureGeminiGuard, geminiHaltReason, generateContent, haltGemini } from './engine/gemini-rest.ts';
import { createSpeaker, type SpeakerSink } from './audio/speaker.ts';
import { styleLine } from './toolkit-candidates/adapters/voice.ts';
import type { XRAudioSettings } from './toolkit-candidates/xr-audio.ts';
import { adaptationTags, type AdaptationTag } from './toolkit-candidates/effect.ts';
import { bootToolkit, ONBOARDING_SOURCE, readModel, writeNeed, type GuideToolkit } from './toolkit/host.ts';
import { ADJUST_DELIVERY_GUIDANCE, ADJUST_DELIVERY_TOOL, planAdjustment, SAID_DURING_TASK_SOURCE } from './toolkit/adjust-delivery.ts';
import { createSession, type Session, type SessionDeps, type SessionEvent } from './runtime/session.ts';
import { createOnboarding, interpretAnswer, READY_LINE } from './runtime/onboarding.ts';
import { createRunRecorder, type RunEventExtras, type RunEventRef } from './runtime/run-recorder.ts';
import type { Task } from './skills/types.ts';
import washingMachine from './tasks/washing-machine.json';
import bill from './tasks/bill.json';

const bridgeToken = requireBridgeToken();

const TASKS: Task[] = [washingMachine as Task, bill as Task];

// How much later a moment's video arrives than the same moment's voice. Starts
// from FRAME_LAG_MS, replaced by a measurement when the phone app's camera
// timing test has been run (camera-lag.ts); the measurement survives restarts.
const LAG_FILE = join(config.appDataDir, '..', '.camera-lag.json');
let cameraLagMs = loadLag(LAG_FILE, config.frameLagMs);
let lagTest: { frames: Array<{ at: number; luma: number }> } | null = null;

// Shared, app-wide frame store: ffmpeg fills it, the session reads it.
const frames = new FrameStore(config.frameRingSize);
let captureHandle: { stop: () => void; retarget: (streamKey: string) => void } | null = null;

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
    onFrame: (jpeg) => {
      frames.push(jpeg);
      // During a camera-timing test every frame's brightness is noted with
      // the time it arrived (camera-lag.ts).
      const watching = lagTest;
      if (watching) {
        const at = Date.now();
        void brightness(jpeg).then((luma) => luma != null && watching.frames.push({ at, luma }));
      }
    },
  });
}

// Everything that lives as long as one phone connection.
interface Live {
  link: PhoneLink;
  session: Session;
  tk: GuideToolkit; // the store this session reads — the profile editor writes to the same handle
  setActive: (on: boolean) => void;
  setMode: (mode: 'baseline' | 'toolkit') => void;
  setOnboarding: (action: 'start' | 'cancel') => void;
  onboardingState: () => OnboardingPanel;
  hear: (text: string) => void;
  onGlasses: () => void;
  onMicAudio: (pcm: Buffer) => void;
  teardown: () => void;
}
let live: Live | null = null;
// Caption ids, app-wide so a new phone never reuses one a page still holds.
let captionSeq = 0;

const CAMERA_RETRIES = 5;
const CAMERA_RETRY_DELAY_MS = 5000;

async function buildLive(link: PhoneLink): Promise<Live> {
  let sessionActive = false;
  let speaking = 0;
  let thinking = 0;
  // From the end of the wearer's speech until the acknowledgement has played.
  let awaitingAck = false;
  // The phone plays a "working on it" sound whenever the phase is 'thinking'.
  // Between the chunks of one paced utterance (the 900 ms pause, the next
  // clip's encoding) nothing is being thought, so the phase stays 'speaking'
  // for a short grace after each chunk — a blip of that sound mid-step reads
  // as the guide losing its place.
  let speakingUntil = 0;
  let speakingGrace: ReturnType<typeof setTimeout> | null = null;
  const holdSpeaking = (ms: number): void => {
    speakingUntil = Date.now() + ms;
    if (speakingGrace) clearTimeout(speakingGrace);
    speakingGrace = setTimeout(() => {
      speakingGrace = null;
      pushState();
    }, ms + 20);
  };
  const dropSpeaking = (): void => {
    speakingUntil = 0;
    if (speakingGrace) clearTimeout(speakingGrace);
    speakingGrace = null;
  };
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
      phase: !sessionActive ? 'idle' : speaking > 0 || Date.now() < speakingUntil ? 'speaking' : thinking > 0 ? 'thinking' : 'listening',
      // The thinking sound comes AFTER the acknowledgement, never under it: it
      // holds off from the end of the wearer's speech until "Okay." has played
      // (or it is clear there will be no acknowledgement). Never during the
      // spoken setup: between two of its lines nothing is being worked out.
      cue: sessionActive && thinking > 0 && speaking === 0 && !awaitingAck && !onboarding.active,
      heard,
      lastLine,
      status,
      geminiOff: geminiHaltReason(),
      onboarding: onboardingPanel(),
    };
    link.sendState(state);
    webview.stage({ kind: 'phase', phase: state.phase });
  };

  // The /webview caption stage: the words go up as the clip is handed to the
  // phone — not when the line is queued, which is seconds earlier — and come
  // down when it has played. Nothing on the speech path waits for this.
  let phoneLoadMs = 0;
  const caption = (text: string, tags: AdaptationTag[], filler = false): (() => void) => {
    const id = ++captionSeq;
    webview.stage({ kind: 'caption', id, on: true, text, tags, filler, lagMs: Math.min(phoneLoadMs, 1500) });
    return () => webview.stage({ kind: 'caption', id, on: false });
  };
  const setStatus = (text: string): void => {
    status = text;
    console.log(`[wearable] ${text}`);
    emit({ type: 'status', text, ts: Date.now() });
    pushState();
  };
  const emit = (
    e: SessionEvent,
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
    // For what the wearer said, the frame kept is the one the answer is made from.
    const ref = runs.event(e, { ...delivery, frame: e.type === 'user' ? frames.viewed() : frames.latest(), mode: st.mode, task: st.task?.id ?? null });
    if (e.type === 'user' && utteranceWav) {
      runs.attachAudio(ref, utteranceWav); // what the mic actually heard, for the runs page
      utteranceWav = null;
    }
    return ref;
  };
  // Everything the wearer says or taps goes through here, so the phone can
  // show "thinking" for as long as the guide is working on it.
  const hear = (text: string, spokenAt?: number): void => {
    // During the spoken setup a reply is an answer to its question, not a
    // request: no frame is pinned or sent, and no filler plays.
    if (onboarding.active) return hearSetup(text);
    // Typed from a panel while the guide is off (the mic is shut, so this can
    // only be typed). The paused session would answer nothing, and a spoken
    // "Okay." with nothing behind it is worse than silence.
    if (!sessionActive) return setStatus('Press Start to begin');
    thinking++;
    // Answer from what the camera saw when they STARTED speaking — by the time
    // the model is called they have often looked away. Video lags the voice
    // on its way here, hence frameLagMs. Typed requests have no such moment.
    if (spokenAt != null) frames.pin(spokenAt + cameraLagMs);
    // A word of acknowledgement while the answer is being made — only if its
    // clip is already made. It must never be something the answer waits for.
    const ack = cannedIfReady(pickFiller(text), styleLine(guideSession.render(), { slower: false }));
    filler = ack ? playClip(ack.text, ack.clip, { caption: false }) : Promise.resolve();
    void filler.finally(() => {
      awaitingAck = false;
      pushState();
    });
    pushState();
    void Promise.resolve(guideSession.onUtterance(text))
      .catch((e) => console.error('[wearable] turn failed:', e instanceof Error ? e.message : e))
      .finally(() => {
        thinking--;
        frames.unpin();
        pushState();
      });
  };

  // Short, neutral, and never the same twice running. A question gets a
  // "looking" line; anything else a plain acknowledgement.
  let filler: Promise<void> = Promise.resolve();
  let lastFiller = '';
  const pickFiller = (said: string): string => {
    const asking = /\?|^(how|what|where|which|why|when|who|can|could|is|are|do|does|help)\b/i.test(said.trim());
    const pool = (asking ? FILLERS.asking : FILLERS.telling).filter((f) => f !== lastFiller);
    lastFiller = pool[Math.floor(Math.random() * pool.length)]!;
    return lastFiller;
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
  type Clip = { wav: Buffer; aac: { audio: Buffer; mime: string; ext: string } };
  const clips = new Map<string, Promise<Clip | null>>();
  const synthOne = (text: string, style: string): Promise<Clip | null> => {
    const key = `${style}\u0000${text}`;
    let p = clips.get(key);
    if (!p) {
      const t0 = Date.now();
      const pending: Promise<Clip | null> = synthesizeSpeech({ apiKey: config.geminiApiKey, model: config.ttsModel, voice: config.ttsVoice, text, stylePrefix: style })
        .then(async (out) => {
          console.log(`[tts] ${((Date.now() - t0) / 1000).toFixed(1)}s for ${text.split(/\s+/).length} words`);
          // Compressed here, while nobody is waiting, rather than when the line is due.
          if (!out) return null;
          const wav = trimSilence(out.wav);
          return { wav, aac: await toAac(wav) };
        })
        // NEVER rejects: the voice is the part that regularly fails (rate
        // limits, timeouts), these promises are cached AND started ahead of
        // need, and in Bun an unhandled rejection ends the process. No clip
        // means the phone reads the line itself; the failure is forgotten so
        // the next line can try again.
        .catch((e) => {
          console.warn(`[tts] failed after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, e instanceof Error ? e.message : e);
          if (clips.get(key) === pending) clips.delete(key);
          return null;
        });
      p = pending;
      clips.set(key, pending);
      setTimeout(() => clips.delete(key), 120_000);
    }
    return p;
  };
  const LONG_LINE_WORDS = 24;
  const synth = (text: string, style: string): Promise<Clip | null> => {
    const parts = chunkText(text, LONG_LINE_WORDS);
    if (parts.length <= 1) return synthOne(text, style);
    return Promise.all(parts.map((part) => synthOne(part, style)))
      .then(async (all) => {
        if (!all.every(Boolean)) return null;
        const wav = joinWavs((all as Clip[]).map((c) => c.wav));
        return { wav, aac: await toAac(wav) };
      })
      .catch((e) => {
        console.warn('[tts] joining a long line failed:', e instanceof Error ? e.message : e);
        return null;
      });
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
      const tLine = Date.now();
      const made = await Promise.race([
        synth(text, styleLine(meta.render, { slower: meta.slower })),
        new Promise<null>((r) => setTimeout(() => r(null), config.ttsDeadlineMs)),
      ]);
      const tReady = Date.now();
      if (!made) console.warn(`[tts] no clip within ${config.ttsDeadlineMs / 1000}s — the phone reads this line itself`);
      if (gone || !sessionActive) return;
      runs.attachAudio(line, made?.wav);
      const clip = made ? made.aac : null;
      await filler; // let "Okay." finish; it is about a second and the voice took longer than that
      if (gone || !sessionActive) return;
      speaking++;
      segmenter.reset();
      pushState();
      // Baseline speaks with no profile and no prompt block: nothing to tag.
      const said = caption(text, guideSession.state().profileOn ? adaptationTags(meta.render, { slower: meta.slower }) : []);
      try {
        const phone = await link.speak(text, clip);
        phoneLoadMs = phone.loadMs;
        // Where a line's time went: waiting for the voice, then the phone's
        // download + player start, then the audio itself.
        const words = text.split(/\s+/).length;
        const secs = made ? (made.wav.length - 44) / (2 * made.wav.readUInt32LE(24)) : 0;
        console.log(
          `[line] ${words}w ≈${secs.toFixed(1)}s audio · voice wait ${((tReady - tLine) / 1000).toFixed(1)}s · phone load ${(phone.loadMs / 1000).toFixed(1)}s · ` +
            `played ${(phone.playMs / 1000).toFixed(1)}s · total ${((Date.now() - tLine) / 1000).toFixed(1)}s`,
        );
      } catch (e) {
        console.error('[wearable] speak failed:', e instanceof Error ? e.message : e);
      } finally {
        said();
        speaking--;
        // More chunks of this line to come: bridge the pause and the next
        // clip's encoding without the phase flickering to 'thinking'.
        if (meta.index < meta.count - 1) holdSpeaking(meta.render.speech.pauseAfterUtteranceMs + 2500);
        else dropSpeaking();
        segmenter.reset();
        pushState();
      }
    },
  };

  // A fixed line, spoken outside the guide's own turn-taking (mic held off
  // while it plays, like any other line).
  const sayCanned = async (text: string, opts: { caption?: boolean } = {}): Promise<void> =>
    playClip(text, await cannedClip(text, styleLine(guideSession.render(), { slower: false })), opts);
  // Starts synchronously (speaking++ before anything is awaited), so the phase
  // never flickers to "thinking" — and its sound — ahead of the clip.
  const playClip = async (text: string, clip: CannedClip | null, opts: { caption?: boolean } = {}): Promise<void> => {
    if (gone || !sessionActive) return;
    if (opts.caption !== false) lastLine = text;
    speaking++;
    // A half-heard utterance is thrown away at a line's edges — except during
    // the setup, which takes an answer between its lines: the phone sends no
    // mic audio while a clip plays, so what was said over it arrives as a
    // tail once the clip ends, and a reset here would lose it.
    if (!onboarding.active) segmenter.reset();
    pushState();
    const said = caption(text, [], opts.caption === false);
    const t0 = Date.now();
    try {
      const phone = await link.speak(text, clip);
      // Enough to see where a fixed line's time went — or that it never ended.
      console.log(
        `[clip] ${text.split(/\s+/).length}w · ${clip ? clip.ext : 'no clip, phone voice'} · phone load ${(phone.loadMs / 1000).toFixed(1)}s · ` +
          `played ${(phone.playMs / 1000).toFixed(1)}s · total ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      console.error(`[wearable] canned line failed after ${((Date.now() - t0) / 1000).toFixed(0)}s:`, e instanceof Error ? e.message : e);
    } finally {
      said();
      speaking--;
      if (!onboarding.active) segmenter.reset();
      pushState();
    }
  };

  // "That was too fast": the model calls adjust_delivery (toolkit/adjust-delivery.ts);
  // this writes the one need, re-reads the profile — the voice follows from the
  // very next line — and tells the model what happened so it can say so.
  const adjustDelivery = async (name: string, args: Record<string, unknown>): Promise<{ result: string; standing?: string }> => {
    if (name !== ADJUST_DELIVERY_TOOL.name) return { result: 'No such tool. Carry on with the task.' };
    const plan = planAdjustment(args, (await readModel(tk))?.needs ?? []);
    if (!plan.ok) return { result: plan.result };
    await writeNeed(tk, plan.key, plan.value, SAID_DURING_TASK_SOURCE);
    await guideSession.refreshProfile();
    console.log(`[profile] the wearer asked for "${String(args.change)}" — ${plan.key} = ${String(plan.value)}, saved`);
    emit({ type: 'status', text: `Profile updated from what you said · ${plan.key} = ${String(plan.value)}`, ts: Date.now() });
    pushState();
    return { result: plan.result, standing: plan.standing };
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
    makeEngine: (si) => {
      // Only the toolkit guide can change how it speaks and remember it: the
      // profile block in its prompt is what marks a toolkit conversation.
      // Baseline stays the raw model — same sentence, no lasting change.
      const adaptive = si.includes('USER PROFILE');
      return createConversation({
        apiKey: config.geminiApiKey,
        model: config.visionModel,
        systemInstruction: adaptive ? `${si}\n\n${ADJUST_DELIVERY_GUIDANCE}` : si,
        temperature: config.llmTemperature,
        tools: adaptive ? [ADJUST_DELIVERY_TOOL] : undefined,
        onToolCall: adaptive ? adjustDelivery : undefined,
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
      });
    },
    tk,
    panel: { emit },
    tasks: TASKS,
    vision: new VisionClient(config.geminiApiKey, config.visionModel),
    initialMode: config.guideMode,
    onFramesUsed: (what, used) => link.sendFramesUsed(what, used),
  };
  const guideSession = createSession(sessionDeps);
  guideSession.setPaused(true);

  // ── Spoken setup (runtime/onboarding.ts) ─────────────────────────────────
  // A third thing the guide can be doing, next to the two modes: a short
  // conversation that fills in the profile. While it runs, what the wearer
  // says goes to it instead of the session (hear). Its lines are fixed, so
  // they use the on-disk clip cache like the opening line — after the first
  // run they play at once — and playClip's mic discipline like any line.
  let setupSummary: string[] = [];
  // Onboarding picked as the mode, which outlives a Stop and survives the
  // setup not having begun yet: it is what makes Start run the setup instead
  // of the guide's opening line. Cleared by picking a mode, by "Stop setup",
  // and by the setup finishing (which hands over to Toolkit mode itself).
  let onboardingChosen = false;
  // One word back from the model, with headroom for thought tokens that bill
  // against the same budget (gemini-rest.ts).
  const SETUP_LABEL_TOKENS = 400;
  // Gemini TTS is steered by its prompt, and a bare line that reads like a
  // request ("Let's set me up so I sound the way you like") gets answered
  // instead of read: no audio comes back. A lead-in that asks for nothing
  // makes every line a transcript, in the engine's own default delivery.
  const setupStyle = (render: XRAudioSettings): string => styleLine(render, { slower: false }) || 'Say the following: ';
  const onboarding = createOnboarding({
    say: async (text, opts) => {
      emit({ type: 'assistant', text, ts: Date.now() });
      const clip = await Promise.race([
        cannedClip(text, setupStyle(opts?.render ?? guideSession.render())).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), config.ttsDeadlineMs)),
      ]);
      // More of the same reply usually follows: the phase stays 'speaking'
      // from the end of this clip until the next is ready, rather than
      // flickering to 'thinking'. setupRun drops the hold when the reply is over.
      holdSpeaking(60_000);
      await playClip(text, clip);
      holdSpeaking(1500);
    },
    prepare: (lines) => {
      for (const l of lines) void cannedClip(l.text, setupStyle(l.render)).catch(() => null);
    },
    interpret: (beat, said) =>
      interpretAnswer(beat, said, {
        classify: (prompt) =>
          generateContent({
            apiKey: config.geminiApiKey,
            model: config.visionModel,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            maxOutputTokens: SETUP_LABEL_TOKENS,
            temperature: 0,
          }).then((r) => r.text),
      }),
    write: async (key, value) => void (await writeNeed(tk, key, value, ONBOARDING_SOURCE)),
    onChange: () => pushState(),
    onDone: (summary) => {
      setupSummary = summary.choices.map((c) => c.label);
      console.log(`[setup] ${summary.ended} · ${setupSummary.join(' · ') || 'nothing chosen'}`);
      // Switched off mid-setup: what was chosen is in the store; say nothing.
      // Onboarding stays the chosen mode, so Start begins the setup again
      // (from the top — the choices already made are saved either way).
      if (summary.ended === 'aborted' || gone || !sessionActive) return void guideSession.refreshProfile().then(pushState);
      // Ran to the end: it hands over to Toolkit mode below, so the tab does too.
      onboardingChosen = false;
      setupRun(
        (async () => {
          // Hand over to the normal guide, adapted to what was just chosen.
          await guideSession.refreshProfile();
          await setMode('toolkit');
          setStatus('Setup done — Toolkit mode is using your choices');
          await playClip(READY_LINE, await cannedClip(READY_LINE, setupStyle(guideSession.render())).catch(() => null));
        })(),
      );
    },
  });
  const onboardingPanel = (): OnboardingPanel => ({
    ...onboarding.progress(),
    chosen: onboardingChosen || onboarding.active,
    summary: onboarding.active ? [] : setupSummary,
  });
  // The mic stays shut for the whole of a reply — between its lines too, when
  // nothing is playing — by counting it as a turn being worked on.
  const setupRun = (work: Promise<void>): void => {
    thinking++;
    awaitingAck = false;
    pushState();
    void work
      .catch((e) => console.error('[setup] failed:', e instanceof Error ? e.message : e))
      .finally(() => {
        thinking--;
        dropSpeaking();
        pushState();
      });
  };
  const hearSetup = (text: string): void => {
    emit({ type: 'user', text, ts: Date.now() });
    setupRun(onboarding.onUtterance(text));
  };
  // Begin the conversation now. The guide must be on: it needs the mic and the
  // speaker. (The camera is on too, and simply not looked at.)
  const beginSetup = (): void => {
    setupSummary = [];
    onboardingChosen = true;
    setStatus('Setup — a few quick choices');
    // Whatever the guide was in the middle of ends here, the way a mode
    // switch ends it: a reply still being written must not talk over this.
    setupRun(Promise.resolve(guideSession.setMode(guideSession.mode())).then(() => onboarding.start()));
  };
  const setOnboarding = (action: 'start' | 'cancel'): void => {
    if (action === 'cancel') {
      onboardingChosen = false;
      return setupRun(onboarding.cancel());
    }
    if (onboarding.active) return;
    // With the guide off, the choice is REMEMBERED rather than refused: the
    // tab stays on Onboarding and Start begins the setup, which is what
    // picking this tab and pressing Start plainly means.
    if (!sessionActive) {
      onboardingChosen = true;
      return setStatus('Setup ready — press Start to begin it');
    }
    beginSetup();
  };

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
  let speechStartedAt = Date.now();
  // A turn being worked on, or a line playing. The setup is the exception:
  // its whole reply counts as one turn (setupRun), but it takes an answer at
  // any point in a beat — between its lines, where the mic is open — and cuts
  // the rest of the beat short (runtime/onboarding.ts, waiting). Without this
  // "the second one", said as soon as the second sample ended, was dropped.
  const busy = (): boolean => speaking > 0 || (thinking > 0 && !onboarding.active);
  const segmenter = createSegmenter(
    {
      onTentative: (pcm) => {
        if (sessionActive && !busy()) early = transcribeNow(pcm);
      },
      onTentativeWithdrawn: () => {
        early = null;
      },
      onUtterance: (pcm, tentativeHeld) => {
        const secs = (pcm.length / 32_000).toFixed(1);
        const reuse = tentativeHeld ? early : null;
        early = null;
        if (!sessionActive || busy()) return void console.log(`[stt] ${secs}s utterance dropped — the guide was busy`);
        console.log(`[stt] ${secs}s utterance${reuse ? ' (transcription already under way)' : ''}`);
        thinking++;
        awaitingAck = true;
        const spokenAt = speechStartedAt;
        pushState();
        void (reuse ?? transcribeNow(pcm)).then((text) => {
          thinking--;
          if (text && sessionActive && !gone) {
            utteranceWav = pcmToWav(pcm, MIC_SAMPLE_RATE); // kept with the turn in the run (emit)
            hear(text, spokenAt);
          } else {
            awaitingAck = false;
            pushState();
          }
        });
      },
      onStart: (agoMs) => {
        speechStartedAt = Date.now() - agoMs;
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
  // NEVER rejects. It is fired and forgotten — from Start, from the glasses
  // reaching Wi-Fi, from the stall watchdog — and in Bun an unhandled
  // rejection ends the process, which would take the whole take down with it.
  // A camera that will not start is a line of status; the guide still talks.
  const startCamera = async (): Promise<void> => {
    try {
      // A start asked for while another is still being answered (Stop then
      // Start in quick succession) is remembered, not dropped — or that take
      // would run with no camera at all and nothing would ever retry it.
      if (cameraStarting) return void (cameraWanted = true);
      if (cameraStarted || !sessionActive) return;
      if (!link.glasses.connected) return setStatus('Connect the glasses in the phone app');
      if (link.glasses.wifi === false) return setStatus('Connect the glasses to Wi-Fi to enable the live camera');
      cameraStarted = true;
      cameraStarting = true;
      // A path of its own for this start, the reader pointed at it, and any
      // stream the glasses left hanging from before cleared away (rtmp.ts).
      const streamKey = newStreamKey();
      currentStreamKey = streamKey;
      dropPublishersExcept(streamKey);
      // Nothing from before this stream may be shown or answered from.
      frames.clear();
      captureHandle?.retarget(streamKey);
      cameraStartedAt = Date.now();
      const url = getPublishUrl(config.rtmpHost, config.rtmpPort, streamKey);
      try {
        return await tryStartCamera(url);
      } finally {
        cameraStarting = false;
        if (cameraWanted) {
          cameraWanted = false;
          if (sessionActive && !cameraStarted && !gone) void startCamera();
        }
      }
    } catch (e) {
      cameraStarted = false;
      cameraStarting = false;
      setStatus(`The camera could not start: ${e instanceof Error ? e.message : String(e)}`);
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
    if (cameraStarted || cameraStarting) link.stopCamera();
    cameraStarted = false;
    cameraWanted = false;
    currentStreamKey = null;
    // The pages go blank rather than hold the take's last picture as if live.
    frames.clear();
    // The glasses often leave the stream's connection open and silent instead
    // of closing it. Give them a moment to do it properly, then close it from
    // this end — which also makes sure they really have stopped encoding.
    setTimeout(() => dropPublishersExcept(currentStreamKey ?? '(none)'), 2500);
  };
  // The stream can die without saying so: the connection stays open and the
  // pictures just stop. Nothing downstream can tell on its own, so this
  // watches for it — no frame for a while during a take means stop the stream
  // and start it again, and say so.
  let lastCameraRestart = 0;
  let cameraStartedAt = 0;
  let cameraWanted = false;
  let currentStreamKey: string | null = null;
  const cameraWatch = setInterval(() => {
    if (gone || !sessionActive || !cameraStarted || cameraStarting) return;
    // Silence is counted from this stream's own start, not from the last
    // frame of the previous one — or every restart would look stalled at once.
    const sinceStart = Date.now() - cameraStartedAt;
    const quiet = Math.min(frames.sinceLastArrivalMs() ?? sinceStart, sinceStart);
    if (quiet < 12_000 || Date.now() - lastCameraRestart < 25_000) return;
    lastCameraRestart = Date.now();
    console.warn(`[wearable] no camera frame for ${(quiet / 1000).toFixed(0)}s — restarting the glasses' stream`);
    setStatus('Camera stalled — restarting it');
    link.stopCamera();
    cameraStarted = false;
    setTimeout(() => void startCamera(), 2000);
  }, 3000);
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
      // Onboarding is the mode showing on the panels: Start means start THAT,
      // not the guide's "what would you like help with?". Either way the
      // camera comes up behind the first words, never in front of them.
      if (onboardingChosen) beginSetup();
      else {
        setStatus('Starting…');
        void sayCanned(OPENING_LINE);
      }
      void startCamera();
    } else {
      void onboarding.cancel({ silent: true }); // what was chosen so far is already saved
      abortInFlightGemini('paused');
      dropSpeaking();
      link.stopAudio();
      stopCamera();
      setStatus('Stopped — camera + AI off');
      if (runId) runs.end('stopped', runId);
      runId = null;
    }
  };

  // Every fixed line in the voice style of the current mode, made (or read
  // from disk) ahead of need. The two modes speak in different styles, so
  // each has its own set.
  const warmCanned = (): void => {
    const style = styleLine(guideSession.render(), { slower: false });
    for (const text of [OPENING_LINE, ...FILLERS.asking, ...FILLERS.telling]) void cannedClip(text, style);
  };
  const setMode = (m: 'baseline' | 'toolkit'): Promise<void> =>
    Promise.resolve(guideSession.setMode(m)).then(() => {
      pushState();
      warmCanned();
    });
  // A mode picked by hand ends the spoken setup (quietly — the person has
  // moved on) and clears its summary, which described the mode they left.
  const chooseMode = (m: 'baseline' | 'toolkit'): Promise<void> => {
    void onboarding.cancel({ silent: true });
    onboardingChosen = false;
    setupSummary = [];
    return setMode(m);
  };

  // Point the panels at this live session.
  const controls = {
    onSay: (t: string) => hear(t), // typed: no moment of speech to pin the camera to
    onSetActive: setActive,
    onSetMode: chooseMode,
    onOnboarding: setOnboarding,
  };
  demo?.update(controls);
  webview.update(controls);

  // Boot mode (toolkit mode reads the profile here). Then the fixed opening
  // line is made ready, so the first Start is as quick as every later one.
  void setMode(config.guideMode).then(warmCanned);

  return {
    link,
    session: guideSession,
    tk,
    setActive,
    setMode: (m) => void chooseMode(m),
    setOnboarding,
    onboardingState: onboardingPanel,
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
      clearInterval(cameraWatch);
      void onboarding.cancel({ silent: true });
      sessionActive = false;
      abortInFlightGemini('phone disconnected');
      guideSession.setPaused(true);
      if (runId) runs.end('disconnected', runId);
      runId = null;
      webview.update({ active: false, onSay: () => {} });
      webview.stage({ kind: 'phase', phase: 'idle' });
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
    onOnboarding: (link, action) => withLive(link, (l) => l.setOnboarding(action)),
    onCalibrateBegin: (link) => {
      const newest = frames.recent().at(-1);
      if (!newest || Date.now() - newest.timestamp > 4000) {
        return link.send({ t: 'calibrate', ready: false, reason: 'The camera is not streaming. Press Start, wait for "listening", then try again.' });
      }
      lagTest = { frames: [] };
      setTimeout(() => (lagTest = null), 40_000); // never left running
      link.send({ t: 'calibrate', ready: true });
    },
    onCalibrateFlashes: (link, at, flashMs) => {
      const test = lagTest;
      if (!test) return link.send({ t: 'calibrated', ok: false, reason: 'The test timed out. Try again.' });
      // The last flash's frames are still on their way: give them time to land.
      setTimeout(() => {
        lagTest = null;
        test.frames.sort((a, b) => a.at - b.at);
        const result = solveLag(test.frames, at, 1000 / config.captureFps, flashMs);
        if (result.ok) {
          cameraLagMs = result.lagMs!;
          saveLag(LAG_FILE, result);
          console.log(`[lag] camera runs ${result.videoMs} ms behind (${result.samples} flashes, spread ${result.spreadMs} ms) — answering from speech start + ${cameraLagMs} ms`);
        } else console.warn(`[lag] camera timing test failed: ${result.reason}`);
        link.send({ t: 'calibrated', ...result });
      }, 6000);
    },
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
  onboardingState: () => live?.onboardingState() ?? null,
});
mountRuns({ app: bridge.app, recorder: runs, password: config.adminPassword });

// Fixed lines the guide says every take ("Starting now.") are made once and
// kept on disk, so after the first time they play the instant they are asked
// for — no Gemini round trip.
const CANNED_DIR = join(config.appDataDir, '..', '.tts-cache');
type CannedClip = { audio: Buffer; mime: string; ext: string };
const canned = new Map<string, Promise<CannedClip | null>>();
// Clips that are in hand right now — what a filler may use without waiting.
const cannedDone = new Map<string, CannedClip>();
const cannedKey = (text: string, style: string): string => createHash('sha1').update(`${config.ttsVoice}|${style}|${text}`).digest('hex');
function cannedIfReady(text: string, style: string): { text: string; clip: CannedClip } | null {
  const clip = cannedDone.get(cannedKey(text, style));
  if (!clip) void cannedClip(text, style); // make it for next time
  return clip ? { text, clip } : null;
}
function cannedClip(text: string, style: string): Promise<{ audio: Buffer; mime: string; ext: string } | null> {
  const key = cannedKey(text, style);
  let p = canned.get(key);
  if (p) return p;
  p = (async () => {
    const file = join(CANNED_DIR, `${key}.aac`);
    if (existsSync(file)) return { audio: readFileSync(file), mime: 'audio/aac', ext: 'aac' };
    const out = await synthesizeSpeech({ apiKey: config.geminiApiKey, model: config.ttsModel, voice: config.ttsVoice, text, stylePrefix: style });
    if (!out) return null;
    const clip = await toAac(trimSilence(out.wav));
    if (clip.ext === 'aac') {
      try {
        mkdirSync(CANNED_DIR, { recursive: true });
        writeFileSync(file, clip.audio);
      } catch (e) {
        console.warn('[tts] could not keep a canned line on disk:', e instanceof Error ? e.message : e);
      }
    }
    return clip;
  })()
    // NEVER rejects: these clips are made ahead of need and fired and
    // forgotten, and in Bun an unhandled rejection ends the process. No clip
    // means the phone reads the line itself.
    .catch((e) => {
      console.warn('[tts] a fixed line failed:', e instanceof Error ? e.message : e);
      return null;
    });
  canned.set(key, p);
  void p.then((c) => (c ? cannedDone.set(key, c) : canned.delete(key)));
  return p;
}

// Said the moment the guide has understood the wearer, to cover the seconds
// the real answer takes. Cached like every fixed line.
const OPENING_LINE = 'Hey there, what would you like help with?';
const FILLERS = {
  asking: ['Let me look.', 'Let me see.', 'One moment.'],
  telling: ['Okay.', 'Alright.', 'Got it.'],
};

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
    onboardingState: () => live?.onboardingState() ?? null,
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
