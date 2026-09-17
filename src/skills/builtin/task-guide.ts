// task-guide — pure policy over an injected engine (docs/PLAN.md §3.6).
//
//   toolkit/stepwise:  each turn asks the engine for the SINGLE next action
//                      (the profile block enforces one-step answers; the
//                      conversation history carries progress); 'done' → next.
//   baseline/continuous: ONE turn, the full answer, spoken raw; 'repeat' is
//                      the speaker's transcript replay, not a new turn.
//
//   verify: ONE vision call where the brief declares it — after an assistant
//   reply mentioning the spec's keyword. 'yes' → speak sayOnYes;
//   no/unclear/timeout/error → SILENCE, never blocks the flow.
//
// Unit tests stub the engine with canned replies and assert the turn
// requests + gating, not the model's prose.

import type { Task, VerifySpec } from '../types.ts';
import type { GuideSkill, SkillMeta } from '../types.ts';

export const taskGuideMeta: SkillMeta = {
  id: 'task-guide',
  name: 'Task Guide',
  description: 'Walks you through a household task — one step at a time when your profile asks for it.',
  supportAreas: ['cognitive', 'memory'],
  icon: 'checklist',
};

export const taskGuide: GuideSkill = { meta: taskGuideMeta };

// A task nobody wrote a script for ("help me set the microwave clock") runs
// through the SAME guide: one step at a time in toolkit mode, 'done'
// advances, 'stop' ends it, repeats count per step — just with no manual
// facts in the prompt and no camera check. The scripted tasks only add those.
export const GENERIC_TASK_ID = 'general';

const TASK_REQUEST_RE =
  /\b(?:help (?:me|us)\b|help with|(?:can|could|would|will) you help|i need help|how (?:do|can|should|would) (?:i|we)(?! (?:know|tell|check|see|find out))|how to|walk me through|talk me through|guide me|show me how|teach me|what are the steps|i(?:'d| would)? (?:want|need|like) to (?:start|set|use|turn|open|run|make|cook|change|put|program|get|switch|clean|adjust|connect|install|fix))\b/;

// Does this utterance ask to be guided through something? Questions about
// the scene ("what is this?", "how do I know it's on?") are conversation.
export function isTaskRequest(utterance: string): boolean {
  return TASK_REQUEST_RE.test(utterance.toLowerCase().replace(/[‘’]/g, "'"));
}

export function genericTask(utterance: string): Task {
  const goal = utterance.trim().replace(/"/g, "'").replace(/[.!?\s]+$/, '').slice(0, 120);
  return { id: GENERIC_TASK_ID, trigger: [], goal, brief: [] };
}

export type VerifyResult = 'yes' | 'no' | 'unclear';

// One word of answer plus headroom for Gemini 3.x thought tokens, which bill
// against this budget and cannot always be disabled (engine/gemini-rest.ts) —
// a small budget starves the answer into an empty candidate → permanent 'unclear'.
export const VERIFY_MAX_OUTPUT_TOKENS = 400;

export function verifyQuestion(prompt: string): string {
  return `${prompt} Answer with exactly one word: yes, no, or unclear.`;
}

// Word-boundary matches: "not sure" / "none visible" must NOT read as "no",
// and "yesterday" must not read as "yes".
export function parseVerifyAnswer(text: string): VerifyResult {
  const t = text.trim().toLowerCase();
  if (/^yes\b/.test(t)) return 'yes';
  if (/^no\b/.test(t)) return 'no';
  return 'unclear';
}

// Does this reply END the task? Judged sentence by sentence, and only in
// stepwise mode (a baseline answer ends with "you're all set" by nature).
// Anything after when/once/until/if/before/while is ignored ("tell me when
// you're done" is a step), a negated clause never counts ("the machine is not
// running"), nor does a question. "<the wash> is running" must be a plain
// statement: subject and state close together, with no "you'll know…",
// "make sure…" or "to get…" in front of it.
const CLAUSE_CUT = /\b(?:when|once|until|if|before|while|as soon as)\b/;
const NEGATION = /\b(?:not|never|isn't|aren't|hasn't|haven't|won't|don't|doesn't)\b/;
const NOTHING_LEFT = /\b(?:no more steps|nothing (?:more|else|left) to do|(?:don't|do not) (?:need|have) to do anything (?:more|else))\b/;
const COMPLETION_PATTERNS = [
  /\bthat(?: is|'s| was) everything\b/,
  /\b(?:that was the (?:last|final) step|task (?:is )?complete)\b/,
  /^all (?:done|finished|set)\b/,
  /\b(?:you are|you're) (?:all |completely )?(?:done|finished|set)\b(?! (?:for|to|with)\b)/,
  /\byou(?:'ve| have) (?:now |just )?started (?:the |your )?(?:wash|machine|cycle|laundry|load)\b/,
];
const RUNNING = /\b(?:washing machine|wash|machine|cycle|laundry|clothes|load)\b(?: [a-z]+){0,3} (?:is|are|has|have|should be)(?: now| already| successfully| all set and)? (?:been )?(?:running|washing|started|starting)\b/;
const NOT_A_STATEMENT = /\b(?:will|'ll|would|going to|to get|to make|make sure|so that|know|see|check|wait for)\b/;

export function isCompletionReply(text: string): boolean {
  return text
    .replace(/[‘’]/g, "'")
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => {
      const s = sentence.trim().toLowerCase();
      if (!s || s.endsWith('?')) return false;
      const clause = s.split(CLAUSE_CUT)[0] ?? '';
      if (NOTHING_LEFT.test(clause)) return true;
      if (NEGATION.test(clause)) return false;
      if (COMPLETION_PATTERNS.some((re) => re.test(clause))) return true;
      const m = RUNNING.exec(clause);
      return !!m && !NOT_A_STATEMENT.test(clause.slice(0, m.index));
    });
}

export interface TaskGuideDeps {
  task: Task;
  mode: 'stepwise' | 'continuous';
  // A conversation engine already composed with base + task brief (+ profile
  // block in toolkit mode). The guide only decides WHAT to ask it.
  engine: { turn(text: string): Promise<string> };
  // One camera check against fresh frames; undefined → verification skipped
  // (e.g. no camera source). Must resolve — the guide adds its own timeout.
  verify?: (prompt: string) => Promise<VerifyResult>;
  // Deliver a reply (the speaker). stepId tags repeat-tracking; remember:false
  // keeps a line out of what "repeat" replays.
  say: (text: string, opts?: { stepId?: string; remember?: boolean }) => Promise<void>;
  verifyTimeoutMs?: number;
}

export interface TaskGuide {
  start(utterance: string): Promise<void>;
  advance(): Promise<void>; // the wearer said 'done'
  ask(utterance: string): Promise<void>; // a question mid-task
  stop(): void;
  readonly active: boolean;
  readonly stepCount: number;
  currentStepId(): string | null;
}

export function createTaskGuide(deps: TaskGuideDeps): TaskGuide {
  const pendingVerify: VerifySpec[] = [...(deps.task.verify ?? [])];
  let active = false;
  let step = 0;
  let finished = false;

  async function runVerify(reply: string): Promise<void> {
    if (!deps.verify) return;
    const i = pendingVerify.findIndex((v) =>
      reply.toLowerCase().includes(v.afterActionMentioning.toLowerCase()),
    );
    if (i < 0) return;
    const spec = pendingVerify.splice(i, 1)[0]!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        deps.verify(spec.prompt),
        new Promise<VerifyResult>((r) => {
          timer = setTimeout(() => r('unclear'), deps.verifyTimeoutMs ?? 6000);
        }),
      ]);
      // A confirmation is not a step: "repeat" afterwards must replay the step.
      if (result === 'yes' && active) {
        await deps.say(spec.sayOnYes, { stepId: `verify-${spec.afterActionMentioning}`, remember: false });
      }
      // no / unclear: stay silent — a wrong "I can see it" is worse than none.
    } catch {
      /* vision failed — silence, never blocks */
    } finally {
      clearTimeout(timer);
    }
  }

  async function speakTurn(prompt: string): Promise<void> {
    const reply = (await deps.engine.turn(prompt)).trim();
    // Stopped while the model was still writing this step: say nothing.
    if (!reply || !active) return;
    if (deps.mode === 'stepwise' && isCompletionReply(reply)) finished = true;
    step++;
    await deps.say(reply, { stepId: `step-${step}` });
    // Verification runs AFTER the step is spoken — the film's beat order
    // (guide says "turn the dial", wearer turns it… but the check fires on
    // the guide's own mention, camera sees the result a beat later).
    await runVerify(reply);
  }

  return {
    async start(utterance: string): Promise<void> {
      active = true;
      finished = false;
      // Both modes open from the wearer's own words. In stepwise mode the
      // profile block makes this first reply a single action; in continuous
      // mode the same engine gives its natural full answer in one turn.
      // Either way the guide STAYS active for follow-up questions (ask()),
      // so "which hole does the soap go in?" lands in the same conversation
      // with the task brief and history — only advance() is mode-gated.
      await speakTurn(utterance);
    },

    async advance(): Promise<void> {
      if (!active || finished || deps.mode !== 'stepwise') return;
      await speakTurn("Done. What's the next step?");
    },

    async ask(utterance: string): Promise<void> {
      if (!active) return;
      await speakTurn(utterance);
    },

    stop(): void {
      active = false;
    },

    get active(): boolean {
      return active && !finished;
    },

    get stepCount(): number {
      return step;
    },

    currentStepId(): string | null {
      return step ? `step-${step}` : null;
    },
  };
}
