// Skill + task contracts, trimmed from the old draft to what the two films
// use. A "skill" here is metadata + an optional prompt block (the panels list
// them; compose() assembles the prompt); the situational monitor machinery
// (onFrame/cadence/tools) stayed in the parts bin.

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  supportAreas: string[];
  icon: string;
}

export interface GuideSkill {
  meta: SkillMeta;
  // Appended to the conversational system instruction when active.
  promptBlock?: string;
}

// A task BRIEF — facts, not wording (docs/PLAN.md §3.6). The model writes
// every spoken line, in both modes; the brief states appliance facts in the
// MANUAL'S OWN register on purpose, so an unprompted model naturally answers
// in manual terms and the profile block does the translating.
export interface VerifySpec {
  afterActionMentioning: string;
  prompt: string;
  sayOnYes: string;
}

export interface Task {
  id: string;
  trigger: string[];
  goal: string;
  brief: string[];
  verify?: VerifySpec[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word matching: "dishwasher" is not "washer", and "wash the car" is
// not "a wash" — an unrelated request must never inherit this task's manual.
export function matchesTask(task: Task, utterance: string): boolean {
  const t = utterance.toLowerCase();
  return task.trigger.some((k) => new RegExp(`\\b${escapeRe(k.toLowerCase())}\\b`).test(t));
}
