// createSession — the runtime state machine (docs/PLAN.md §3.5). Replaces
// the old draft's 458-line orchestrator with the guide's actual shape:
//
//   utterance → [stop|repeat|done] → [read request]
//             → [scripted task trigger] → [any other "help me…" task]
//             → free conversation turn
//
// and one mode switch, setMode('baseline'|'toolkit'), which is the entire
// A/B: choosing toolkit mode reads the profile straight away (readModel) →
// render + prompt block; baseline is render(null) and no block. The same
// engine generates every reply in both modes.
//
// Every public method resolves — never rejects. Hosts fire them from mic and
// HTTP callbacks without awaiting, and in Bun an unhandled rejection ends the
// process: one rate-limited model call must not take down a take.

import type { FrameStore, FrameEntry } from '../transport/frames.ts';
import type { VisionClient } from '../engine/vision.ts';
import type { TurnEngine } from '../engine/engine.ts';
import type { Speaker } from '../audio/speaker.ts';
import { renderXRAudioSettings, type XRAudioSettings } from '../toolkit-candidates/xr-audio.ts';
import { profilePromptBlock } from '../toolkit-candidates/adapters/prompt-directives.ts';
import { readModel, type GuideToolkit } from '../toolkit/host.ts';
import { composePrompt } from '../skills/compose.ts';
import { matchesTask, type Task } from '../skills/types.ts';
import {
  createTaskGuide,
  genericTask,
  GENERIC_TASK_ID,
  isTaskRequest,
  parseVerifyAnswer,
  verifyQuestion,
  VERIFY_MAX_OUTPUT_TOKENS,
  type TaskGuide,
  type VerifyResult,
} from '../skills/builtin/task-guide.ts';
import { readTextAloud, readVisibleText, isReadRequest } from '../skills/builtin/read-text-aloud.ts';
import { generateTaskBrief } from '../skills/task-brief.ts';
import type { AbilityModel } from '@ai4a11y/toolkit';

export type GuideMode = 'baseline' | 'toolkit';

// The toolkit doing something, as it happens: the profile read starting, a
// profile in use, a changed profile picked up, or nothing to adapt to
// (baseline, an empty store, a failed read).
export type ToolkitMoment = 'reading' | 'loaded' | 'updated' | 'none';

export interface SessionEvent {
  type: 'user' | 'assistant' | 'status' | 'hud';
  text: string;
  ts: number;
  skill?: string;
  // Set on the status line that reports a toolkit moment, so a panel can show
  // it as more than a log row.
  toolkit?: ToolkitMoment;
}

export interface PanelBus {
  emit(e: SessionEvent): void;
}

export interface SessionState {
  mode: GuideMode;
  // True when toolkit mode has read a profile and is adapting to it.
  profileOn: boolean;
  needs: Array<{ dimension: string; value: unknown; source?: string }>;
  captionsMirror: boolean;
  rate: number;
  deliveryMode: 'continuous' | 'stepwise';
  task: { id: string; active: boolean; stepCount: number } | null;
  paused: boolean;
  switching: boolean;
}

export interface SessionDeps {
  frames: FrameStore;
  speaker: Speaker;
  makeEngine: (systemInstruction: string) => TurnEngine;
  tk: GuideToolkit | null;
  panel: PanelBus;
  tasks: Task[];
  vision: VisionClient | null;
  initialMode?: GuideMode;
  // Debug: told which camera frames go to the model, each time some do (an
  // empty list = the model was asked without a picture). `what` says why.
  onFramesUsed?: (what: string, frames: FrameEntry[]) => void;
}

export interface Session {
  // Resolves once the switch — and any switch requested meanwhile — has
  // finished.
  setMode(mode: GuideMode): Promise<void>;
  // The profile in the store changed (the panels' editor): in toolkit mode,
  // re-read it and adapt from the next turn on. Baseline ignores it — the
  // store is read only when Toolkit mode is chosen.
  refreshProfile(): Promise<void>;
  onUtterance(text: string): Promise<void>;
  setPaused(paused: boolean): void;
  state(): SessionState;
  mode(): GuideMode;
  render(): XRAudioSettings;
}

const DONE_RE = /^(done|next|ok(ay)?,? ?(done|next)?|i'?m done|finished|it'?s done|got it)[.!]?$/i;
const REPEAT_RE =
  /^(please )?((can|could|would) you( please)? )?(repeat( that| it)?|again|say (that|it) again|one more time|come again)[.?!]*$|^((sorry|pardon)( me)?|what was that)[.?!]*$/i;
const STOP_RE = /^(stop|cancel|never ?mind|quit|end task)[.!]?$/i;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

export function createSession(deps: SessionDeps): Session {
  let mode: GuideMode = deps.initialMode ?? 'baseline';
  let model: AbilityModel | null = null;
  let render: XRAudioSettings = renderXRAudioSettings(null);
  let block = '';
  let chat: TurnEngine | null = null;
  let guide: TaskGuide | null = null;
  let guideEngine: TurnEngine | null = null;
  let activeTask: Task | null = null;
  let paused = false;
  let switching = false;
  let switchPromise: Promise<void> = Promise.resolve();
  // A mode requested while a switch is still running (the profile read is
  // async); the running switch applies it before its promise resolves.
  let queuedMode: GuideMode | null = null;
  // Bumped on every mode request: work started under an older generation
  // (a model reply still being written) must not speak afterwards.
  let modeGen = 0;
  // Each conversation answer gets its own repeat id, so the speaker's
  // per-line repeat count means the same line, not any two answers.
  let chatTurns = 0;
  // Briefs the model wrote, by request. Kept across mode switches on purpose:
  // the baseline take and the toolkit take of one request read the same brief.
  const briefs = new Map<string, Task>();

  const status = (text: string, toolkit?: ToolkitMoment) =>
    deps.panel.emit({ type: 'status', text, ts: Date.now(), ...(toolkit ? { toolkit } : {}) });

  // Every frame on its way to the model passes through here.
  const using = (what: string, frames: FrameEntry[]): FrameEntry[] => {
    deps.onFramesUsed?.(what, frames);
    return frames;
  };

  function chatInstruction(): string {
    return composePrompt({ profileBlock: block, extra: [readTextAloud.promptBlock ?? ''] });
  }

  function applyModel(m: AbilityModel | null): void {
    model = m;
    render = renderXRAudioSettings(m);
    block = m ? profilePromptBlock(m, render) : '';
    deps.speaker.setRender(render);
  }

  const visionVerify =
    deps.vision != null
      ? async (prompt: string): Promise<VerifyResult> => {
          const fresh: FrameEntry[] = using('Checking the step', await deps.frames.captureNext(1, 2500));
          if (!fresh.length) return 'unclear';
          const out = await deps.vision!.generate({
            frames: fresh,
            text: verifyQuestion(prompt),
            maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
            temperature: 0,
          });
          return parseVerifyAnswer(out);
        }
      : undefined;

  async function startTask(task: Task, utterance: string): Promise<void> {
    deps.speaker.reset(); // fresh repeat memory per task
    activeTask = task;
    guideEngine = deps.makeEngine(composePrompt({ task, profileBlock: block }));
    const gen = modeGen;
    let created: TaskGuide | null = null;
    created = createTaskGuide({
      task,
      mode: render.delivery.mode,
      engine: { turn: (t) => guideEngine!.turn(t, using('Guiding the task', deps.frames.recent())) },
      verify: visionVerify,
      // A step that finishes generating after "stop" or a mode switch is dropped.
      say: (t, o) => (gen === modeGen && guide === created && !paused ? deps.speaker.say(t, o) : Promise.resolve()),
    });
    guide = created;
    status(`Task: ${task.goal} · ${render.delivery.mode === 'stepwise' ? 'one step at a time' : 'full walkthrough'}`);
    await created.start(utterance);
  }

  // The brief for a task nobody scripted: written by the model from the
  // request and the camera view, once, with no profile or mode in the prompt.
  const briefKey = (request: string) => request.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  async function taskFor(request: string): Promise<Task> {
    const known = briefs.get(briefKey(request));
    if (known) return known;
    if (!deps.vision) return genericTask(request);
    status('Working out the task from your words and the camera view…');
    try {
      const task = await generateTaskBrief({ request, frames: using('Writing the task brief', deps.frames.recent()), vision: deps.vision });
      if (task.brief.length) {
        briefs.set(briefKey(request), task); // a request-only fallback is not kept: next time tries again
        status(`Brief written by the model — the same one serves both modes: ${task.brief.join(' · ')}`);
      } else {
        status('The model gave no usable brief — guiding from your request alone');
      }
      return task;
    } catch (e) {
      status(`Could not write a brief (${errorText(e)}) — guiding from your request alone`);
      return genericTask(request);
    }
  }

  async function handleRead(text: string): Promise<void> {
    if (!deps.vision) return freeTurn(text);
    const gen = modeGen;
    const frames = using('Reading text', await deps.frames.captureNext(2, 3000));
    const result = await readVisibleText({ frames, vision: deps.vision });
    if (gen !== modeGen) return;
    if (!result) {
      await deps.speaker.say("I can't read that clearly. Could you hold it steady, a bit closer?", { stepId: 'read' });
      return;
    }
    if (mode === 'toolkit' && render.delivery.gistFirst) {
      // The verbatim read goes through the engine so the profile block turns
      // it into gist-first delivery — the toolkit adapting the model's output
      // path for video 2.
      const reply = await ensureChat().turn(
        `The camera just read this ${result.kind} the user is holding up. Its verbatim text: """${result.text}""" — tell the user about it, following your delivery directives.`,
      );
      if (gen !== modeGen) return;
      await deps.speaker.say(reply || `It says: ${result.text}`, { stepId: 'read' });
    } else {
      // Baseline: verbatim, exactly as printed.
      await deps.speaker.say(`It says: ${result.text}`, { stepId: 'read' });
    }
  }

  function ensureChat(): TurnEngine {
    if (!chat) chat = deps.makeEngine(chatInstruction());
    return chat;
  }

  async function freeTurn(text: string): Promise<void> {
    const gen = modeGen;
    const reply = await ensureChat().turn(text, using('Answering', deps.frames.recent()));
    if (reply && gen === modeGen && !paused) await deps.speaker.say(reply, { stepId: `chat-${++chatTurns}` });
  }

  function setMode(next: GuideMode): Promise<void> {
    modeGen++;
    if (switching) {
      // A toggle while a switch is still running must not be dropped: the
      // running switch applies the latest request before its promise resolves.
      queuedMode = next;
      return switchPromise;
    }
    switchPromise = switchTo(next);
    return switchPromise;
  }

  async function switchTo(next: GuideMode): Promise<void> {
    switching = true;
    try {
      deps.speaker.reset(); // one take's repeat memory must not leak into the next mode
      guide = null;
      guideEngine = null;
      activeTask = null;
      chat = null;
      mode = next;
      if (next === 'toolkit' && deps.tk) {
        // Choosing Toolkit mode is the go-ahead: read the profile and adapt.
        status('Toolkit mode — reading the profile…', 'reading');
        applyModel(await readModel(deps.tk));
        const n = model?.needs?.length ?? 0;
        status(
          model
            ? `Toolkit mode — profile read · ${n} need${n === 1 ? '' : 's'} · rate ${render.speech.rate}× · ${render.delivery.mode}`
            : 'Toolkit mode — no profile in the store, running with defaults',
          model ? 'loaded' : 'none',
        );
      } else {
        applyModel(null);
        status(next === 'toolkit' ? 'Toolkit mode requested but no toolkit store — running baseline' : 'Baseline mode — raw model output, default delivery', 'none');
      }
    } catch (e) {
      applyModel(null);
      status(`Mode switch failed — running with defaults: ${errorText(e)}`, 'none');
    } finally {
      switching = false;
    }
    const again = queuedMode;
    queuedMode = null;
    if (again && again !== mode) {
      modeGen++;
      await switchTo(again);
    }
  }

  // Same read as choosing Toolkit mode, without the reset a switch does: the
  // delivery (speaker render) changes at once, and the conversation engine
  // is dropped so its next turn is built with the new prompt block. A task
  // already under way keeps the engine it started with — its prompt and
  // pacing were fixed when the task began — and picks the change up on the
  // next task.
  async function refreshProfile(): Promise<void> {
    if (mode !== 'toolkit' || !deps.tk || switching) return;
    try {
      applyModel(await readModel(deps.tk));
      chat = null;
      const n = model?.needs?.length ?? 0;
      status(
        `Profile updated · ${n} need${n === 1 ? '' : 's'} · rate ${render.speech.rate}× · ${render.delivery.mode}` +
          (guide?.active ? ' · the running task keeps its pacing until the next one' : ''),
        model ? 'updated' : 'none',
      );
    } catch (e) {
      status(`Profile re-read failed — keeping the last one: ${errorText(e)}`);
    }
  }

  async function onUtterance(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;

    if (paused) {
      status('Press Start to begin');
      return;
    }

    deps.panel.emit({ type: 'user', text: clean, ts: Date.now() });

    try {
      // 1. Deterministic controls — never sent to the model.
      if (STOP_RE.test(clean)) {
        deps.speaker.stop();
        guide?.stop();
        guide = null;
        activeTask = null;
        status('Task stopped');
        return;
      }
      if (REPEAT_RE.test(clean)) {
        const had = await deps.speaker.repeat();
        if (!had) status('Nothing to repeat yet');
        return;
      }
      if (guide?.active && render.delivery.confirmToAdvance && DONE_RE.test(clean)) {
        await guide.advance();
        return;
      }

      // 2. Read request (video 2) — before task triggers, so "what does this
      //    letter say?" held up to a bill reads it rather than starting a task.
      if (isReadRequest(clean)) {
        await handleRead(clean);
        return;
      }

      // 3. Scripted task trigger — when no task is running, or only a
      //    script-free one is (its manual makes the script the better guide).
      if (!guide?.active || activeTask?.id === GENERIC_TASK_ID) {
        const task = deps.tasks.find((t) => matchesTask(t, clean));
        if (task) {
          await startTask(task, clean);
          return;
        }
      }
      //    Any other request to be guided runs the same guide on a brief the
      //    model writes (or, with no camera client, on the request alone).
      if (!guide?.active && isTaskRequest(clean)) {
        const gen = modeGen;
        const task = await taskFor(clean);
        if (gen !== modeGen) return; // mode changed while the brief was written
        await startTask(task, clean);
        return;
      }

      // 4. Mid-task question or free conversation.
      if (guide?.active) {
        await guide.ask(clean);
        return;
      }
      await freeTurn(clean);
    } catch (e) {
      const msg = errorText(e);
      console.error(`[session] turn failed: ${msg}`);
      status(`Guide error — ${msg}`);
      // An apology is not a step: "repeat" afterwards must replay the step.
      await deps.speaker
        .say("Sorry, I didn't manage that. Please try again.", { stepId: 'error', remember: false })
        .catch(() => {});
    }
  }

  return {
    setMode,
    refreshProfile,
    onUtterance,

    setPaused(p: boolean): void {
      paused = p;
      if (p) deps.speaker.stop();
    },

    state(): SessionState {
      return {
        mode,
        profileOn: model != null,
        needs: (model?.needs ?? []).map((n) => ({ dimension: n.dimension, value: n.value, source: n.source })),
        captionsMirror: render.captionsMirror,
        rate: render.speech.rate,
        deliveryMode: render.delivery.mode,
        task: activeTask ? { id: activeTask.id, active: guide?.active ?? false, stepCount: guide?.stepCount ?? 0 } : null,
        paused,
        switching,
      };
    },

    mode(): GuideMode {
      return mode;
    },

    render(): XRAudioSettings {
      return render;
    },
  };
}
