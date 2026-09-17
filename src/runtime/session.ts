// createSession — the runtime state machine (docs/PLAN.md §3.5). Replaces
// the old draft's 458-line orchestrator with the guide's actual shape:
//
//   utterance → [consent answer?] → [stop|repeat|done] → [read request]
//             → [scripted task trigger] → [any other "help me…" task]
//             → free conversation turn
//
// and one mode switch, setMode('baseline'|'toolkit'), which is the entire
// A/B: toolkit mode runs ensureGrant (the spoken-consent beat) → readModel →
// render + prompt block; baseline is render(null) and no block. The same
// engine generates every reply in both modes.
//
// Every public method resolves — never rejects. Hosts fire them from mic and
// HTTP callbacks without awaiting, and in Bun an unhandled rejection ends the
// process: one rate-limited model call must not take down a take.
//
// A consent card moves through phases: 'asking' (the question is being
// spoken — a bare yes/no counts), 'listening' (capture holds the next
// utterance), and 'tap-only' (nobody answered in time; only a panel tap can
// answer, so a later "okay" meant for a step is never taken as consent).

import type { FrameStore, FrameEntry } from '../transport/frames.ts';
import type { VisionClient } from '../engine/vision.ts';
import type { TurnEngine } from '../engine/engine.ts';
import type { Speaker } from '../audio/speaker.ts';
import { renderAudioSettings, type AudioRender } from '../audio/render.ts';
import { profilePromptBlock } from '../toolkit/prompt-block.ts';
import { ensureGrant, isPending, readModel, proposeInsight, type GuideToolkit } from '../toolkit/host.ts';
import { parseBareConsentAnswer, type ConsentCard } from '../toolkit/consent-audio.ts';
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

export interface SessionEvent {
  type: 'user' | 'assistant' | 'status' | 'hud' | 'learn';
  text: string;
  ts: number;
  skill?: string;
}

export interface PanelBus {
  emit(e: SessionEvent): void;
}

export interface SessionState {
  mode: GuideMode;
  granted: boolean;
  needs: Array<{ dimension: string; value: unknown; source?: string }>;
  captionsMirror: boolean;
  rate: number;
  deliveryMode: 'continuous' | 'stepwise';
  consentCard: ConsentCard | null;
  // True while a consent question is waiting for the wearer's spoken answer.
  listening: boolean;
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
}

export interface Session {
  // Resolves once the switch — including a consent question and any switch
  // requested meanwhile — has finished.
  setMode(mode: GuideMode): Promise<void>;
  onUtterance(text: string): Promise<void>;
  // Panel tap on the consent card ('accept' | 'declineOnce').
  respondConsent(response: 'accept' | 'declineOnce'): Promise<void>;
  // The speaker's repeat-pattern hook lands here (wired by the host).
  onRepeatPattern(info: { stepId: string | null; count: number }): void;
  setPaused(paused: boolean): void;
  // consent-audio's io half: show/clear the card; await the wearer's answer.
  setCard(card: ConsentCard | null): void;
  waitAnswer(timeoutMs: number): Promise<string | null>;
  state(): SessionState;
  mode(): GuideMode;
  render(): AudioRender;
}

const DONE_RE = /^(done|next|ok(ay)?,? ?(done|next)?|i'?m done|finished|it'?s done|got it)[.!]?$/i;
const REPEAT_RE =
  /^(please )?((can|could|would) you( please)? )?(repeat( that| it)?|again|say (that|it) again|one more time|come again)[.?!]*$|^((sorry|pardon)( me)?|what was that)[.?!]*$/i;
const STOP_RE = /^(stop|cancel|never ?mind|quit|end task)[.!]?$/i;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

export function createSession(deps: SessionDeps): Session {
  let mode: GuideMode = deps.initialMode ?? 'baseline';
  let model: AbilityModel | null = null;
  let render: AudioRender = renderAudioSettings(null);
  let block = '';
  let chat: TurnEngine | null = null;
  let guide: TaskGuide | null = null;
  let guideEngine: TurnEngine | null = null;
  let activeTask: Task | null = null;
  let card: ConsentCard | null = null;
  let cardPhase: 'asking' | 'listening' | 'tap-only' | null = null;
  let paused = false;
  let switching = false;
  let switchPromise: Promise<void> = Promise.resolve();
  // A mode requested while a switch (and its consent question) is running.
  let pendingMode: GuideMode | null = null;
  // Bumped on every mode request: work started under an older generation
  // (a model reply still being written, an insight beat) must not speak or
  // apply anything afterwards.
  let modeGen = 0;
  let insightProposed = false;
  // Each conversation answer gets its own repeat id, so "the same line twice"
  // (the slow-down trigger) means the same line, not any two answers.
  let chatTurns = 0;
  // Briefs the model wrote, by request. Kept across mode switches on purpose:
  // the baseline take and the toolkit take of one request read the same brief.
  const briefs = new Map<string, Task>();

  // The one pending "wearer's next answer" waiter (consent capture).
  let answerWaiter: { resolve: (t: string | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  const status = (text: string) => deps.panel.emit({ type: 'status', text, ts: Date.now() });

  function chatInstruction(): string {
    return composePrompt({ profileBlock: block, extra: [readTextAloud.promptBlock ?? ''] });
  }

  function applyModel(m: AbilityModel | null): void {
    model = m;
    render = renderAudioSettings(m);
    block = m ? profilePromptBlock(m, render) : '';
    deps.speaker.setRender(render);
    chat?.setSystemInstruction(chatInstruction());
    if (guideEngine && activeTask) {
      guideEngine.setSystemInstruction(composePrompt({ task: activeTask, profileBlock: block }));
    }
  }

  async function refreshModel(): Promise<void> {
    if (!deps.tk || mode !== 'toolkit') return;
    const m = await readModel(deps.tk);
    if (mode !== 'toolkit') return; // switched to baseline while reading
    applyModel(m);
  }

  function settleWaiter(value: string | null, timedOut = false): void {
    if (!answerWaiter) return;
    const w = answerWaiter;
    answerWaiter = null;
    clearTimeout(w.timer);
    // After an answer capture may re-ask (the question is live again); after
    // silence the card is left for a tap only.
    if (card) cardPhase = timedOut ? 'tap-only' : 'asking';
    w.resolve(value);
  }

  // Close any open consent question: the card disappears and a listening
  // capture hears "no answer", so ensureGrant / the insight beat finish now.
  function cancelConsent(): void {
    card = null;
    cardPhase = null;
    settleWaiter(null);
  }

  const visionVerify =
    deps.vision != null
      ? async (prompt: string): Promise<VerifyResult> => {
          const fresh: FrameEntry[] = await deps.frames.captureNext(1, 2500);
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
      engine: { turn: (t) => guideEngine!.turn(t, deps.frames.recent()) },
      verify: visionVerify,
      // A step that finishes generating after "stop" or a mode switch is dropped.
      say: (t, o) => (gen === modeGen && guide === created ? deps.speaker.say(t, o) : Promise.resolve()),
    });
    guide = created;
    status(`Task: ${task.goal} · ${render.delivery.mode === 'stepwise' ? "one step at a time — say 'done' to advance" : 'full walkthrough'}`);
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
      const task = await generateTaskBrief({ request, frames: deps.frames.recent(), vision: deps.vision });
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
    const frames = await deps.frames.captureNext(2, 3000);
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
    const reply = await ensureChat().turn(text, deps.frames.recent());
    if (reply && gen === modeGen) await deps.speaker.say(reply, { stepId: `chat-${++chatTurns}` });
  }

  function setMode(next: GuideMode): Promise<void> {
    modeGen++;
    if (switching) {
      // A toggle (or Reset take) while the consent question is open must not
      // be dropped: close the question, and let the running switch apply the
      // latest request before its promise resolves.
      pendingMode = next;
      cancelConsent();
      return switchPromise;
    }
    switchPromise = switchTo(next);
    return switchPromise;
  }

  async function switchTo(next: GuideMode): Promise<void> {
    switching = true;
    try {
      cancelConsent(); // a card left from an unanswered question belongs to the old mode
      deps.speaker.reset(); // a take's repeat counts must not leak into the next mode
      guide = null;
      guideEngine = null;
      activeTask = null;
      chat = null;
      insightProposed = false;
      mode = next;
      if (next === 'toolkit' && deps.tk) {
        status('Toolkit mode — checking profile access…');
        const grant = await ensureGrant(deps.tk);
        if (grant === 'granted') {
          applyModel(await readModel(deps.tk));
          const n = model?.needs?.length ?? 0;
          status(`Profile granted · ${n} need${n === 1 ? '' : 's'} · rate ${render.speech.rate}× · ${render.delivery.mode}`);
        } else {
          applyModel(null);
          status(grant === 'declined' ? 'Profile access declined — running with defaults' : 'Profile access pending — tap the card to answer');
        }
      } else {
        applyModel(null);
        status(next === 'toolkit' ? 'Toolkit mode requested but no toolkit store — running baseline' : 'Baseline mode — raw model output, default delivery');
      }
    } catch (e) {
      applyModel(null);
      status(`Mode switch failed — running with defaults: ${errorText(e)}`);
    } finally {
      switching = false;
    }
    const again = pendingMode;
    pendingMode = null;
    if (again && (again !== mode || (again === 'toolkit' && !model))) {
      modeGen++;
      await switchTo(again);
    }
  }

  async function respondConsent(response: 'accept' | 'declineOnce'): Promise<void> {
    // A listening capture wins: feed it the literal the parser maps back.
    if (answerWaiter) {
      settleWaiter(response === 'accept' ? 'yes' : 'not now');
      return;
    }
    if (!card || !deps.tk) return;
    const { id, kind } = card;
    card = null;
    cardPhase = null;
    try {
      const res = await deps.tk.librarian.respondToProposal(id, response);
      if (!res.ok) {
        status(`Consent response failed: ${res.reason ?? 'unknown'}`);
        return;
      }
      if (response === 'accept') {
        await refreshModel();
        if (kind === 'grant') status('Profile access granted');
        else if (mode === 'toolkit') {
          deps.panel.emit({
            type: 'learn',
            text: `Applied: speaking rate is now ${render.speech.rate}× — profile updated with your consent`,
            ts: Date.now(),
          });
        }
      } else {
        status('Okay — leaving things as they are');
      }
    } catch (e) {
      status(`Consent response failed: ${errorText(e)}`);
    }
  }

  async function onUtterance(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;

    // 1. A listening consent capture consumes the next utterance outright.
    if (answerWaiter) {
      deps.panel.emit({ type: 'user', text: clean, ts: Date.now() });
      settleWaiter(clean);
      return;
    }

    // 2. While a consent question is being spoken (capture not yet
    //    listening), a bare yes/no answers it. Consent costs no model call, so
    //    this works while paused too — the boot-time question is asked before
    //    anyone presses Start. Stop and done are never taken as answers.
    const isControl = STOP_RE.test(clean) || (!!guide?.active && render.delivery.confirmToAdvance && DONE_RE.test(clean));
    if (card && cardPhase === 'asking' && !isControl) {
      const bare = parseBareConsentAnswer(clean);
      if (bare) {
        deps.panel.emit({ type: 'user', text: clean, ts: Date.now() });
        return respondConsent(bare);
      }
    }

    if (paused) {
      status('Press Start to begin');
      return;
    }

    deps.panel.emit({ type: 'user', text: clean, ts: Date.now() });

    try {
      // 3. Deterministic controls — never sent to the model.
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

      // 4. Read request (video 2) — before task triggers, so "what does this
      //    letter say?" held up to a bill reads it rather than starting a task.
      if (isReadRequest(clean)) {
        await handleRead(clean);
        return;
      }

      // 5. Scripted task trigger — when no task is running, or only a
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

      // 6. Mid-task question or free conversation.
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

  function onRepeatPattern(_info: { stepId: string | null; count: number }): void {
    if (mode !== 'toolkit' || !deps.tk || !model || insightProposed) return;
    insightProposed = true;
    const currentRate = render.speech.rate;
    const slower = Math.max(0.7, Math.round((currentRate - 0.1) * 10) / 10);
    if (slower >= currentRate) return;
    // Change only the rate need. Writing the whole needs array would pass
    // every need through the toolkit's cross-app cap and silently downgrade
    // the user's floor needs to preferences. (Export order matches the stored
    // array; the export drops only malformed entries.)
    const needs = model.needs ?? [];
    const index = needs.findIndex((n) => n.dimension === 'readAloudRate');
    const rateNeed = {
      ...(index >= 0 ? needs[index]! : { dimension: 'readAloudRate', strength: 'preference' as const }),
      value: slower,
      source: 'wearable-extension-insight',
    };
    const gen = modeGen;
    const stale = () => gen !== modeGen || mode !== 'toolkit';
    void (async () => {
      const tk = deps.tk!;
      const proposal = await proposeInsight(
        tk,
        'speech.readAloudRate',
        { op: 'profile-set', path: `fields.needs.${index >= 0 ? index : needs.length}`, value: rateNeed },
        `You asked me to repeat that step twice. Want me to speak a little slower from now on — ${slower} times speed?`,
        'Speak a bit slower',
      );
      if (!proposal) {
        insightProposed = false; // machinery said not now (cap/dedup) — allow a later retry
        return;
      }
      if (stale() || !tk.consent.present || !tk.consent.capture) return;
      await tk.consent.present({ type: 'cross-app-insight', proposal });
      // Answered while the suggestion was still being spoken — respondConsent
      // has already applied it. Listening now would swallow the next sentence.
      if (stale() || !(await isPending(tk, proposal.id))) return;
      const answer = await tk.consent.capture(proposal.id);
      if (!answer) {
        // Nobody answered: withdraw the suggestion rather than leave a card up
        // that a later "okay" for a step could be mistaken for.
        if (card?.id === proposal.id) {
          card = null;
          cardPhase = null;
        }
        return;
      }
      if (stale() || !(await isPending(tk, proposal.id))) return;
      card = null;
      cardPhase = null;
      const res = await tk.librarian.respondToProposal(proposal.id, answer);
      if (res.ok && answer === 'accept') {
        await refreshModel();
        deps.panel.emit({
          type: 'learn',
          text: `Applied: speaking rate is now ${render.speech.rate}× — profile updated with your consent`,
          ts: Date.now(),
        });
      } else if (res.ok) {
        status('Okay — keeping the current pace');
      }
    })().catch((e) => status(`Insight beat failed: ${errorText(e)}`));
  }

  return {
    setMode,
    onUtterance,
    respondConsent,
    onRepeatPattern,

    setPaused(p: boolean): void {
      paused = p;
      if (p) deps.speaker.stop();
    },

    setCard(c: ConsentCard | null): void {
      card = pendingMode ? null : c;
      cardPhase = card ? 'asking' : null;
    },

    waitAnswer(timeoutMs: number): Promise<string | null> {
      // Capture only waits while a consent card is up. If the card is gone,
      // someone already answered it (or the mode is changing).
      if (!card || pendingMode) return Promise.resolve(null);
      settleWaiter(null); // a newer waiter replaces an older one
      cardPhase = 'listening';
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => settleWaiter(null, true), timeoutMs);
        answerWaiter = { resolve, timer };
      });
    },

    state(): SessionState {
      return {
        mode,
        granted: model != null,
        needs: (model?.needs ?? []).map((n) => ({ dimension: n.dimension, value: n.value, source: n.source })),
        captionsMirror: render.captionsMirror,
        rate: render.speech.rate,
        deliveryMode: render.delivery.mode,
        consentCard: card,
        listening: answerWaiter != null,
        task: activeTask ? { id: activeTask.id, active: guide?.active ?? false, stepCount: guide?.stepCount ?? 0 } : null,
        paused,
        switching,
      };
    },

    mode(): GuideMode {
      return mode;
    },

    render(): AudioRender {
      return render;
    },
  };
}
