// Skill catalog — exactly the two skills the films use (docs/PLAN.md §2).
// Everything else stayed in the old draft's parts bin, re-copyable on demand.

import type { GuideSkill } from './types.ts';
import { taskGuide } from './builtin/task-guide.ts';
import { readTextAloud } from './builtin/read-text-aloud.ts';

export const REGISTRY: GuideSkill[] = [taskGuide, readTextAloud];

export function registryForPanels(): Array<GuideSkill['meta']> {
  return REGISTRY.map((s) => s.meta);
}
