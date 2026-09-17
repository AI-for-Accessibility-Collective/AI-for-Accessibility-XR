// stop.test.ts — which processes `bun run stop` targets: this app's processes
// and their children (and the old wearable draft's), never another project's,
// never itself.

import { describe, expect, test } from 'bun:test';
import { pickTargets, underRoots, type Proc } from '../scripts/stop.ts';

const ROOT = '/work/toolkitv2/wearable-extension';
const OLD_DRAFT = '/work/AI-for-Accessibility-Toolkit-Draft/wearable';

describe('pickTargets', () => {
  const procs: Proc[] = [
    { pid: 10, ppid: 1, command: 'bun run demo' },
    { pid: 11, ppid: 10, command: 'bun src/scripts/drive-core.ts' },
    { pid: 12, ppid: 11, command: 'ffmpeg -loglevel warning -i rtmp://127.0.0.1:1935/live/stream -f image2pipe pipe:1' },
    { pid: 13, ppid: 1, command: 'bun src/index.ts' },
    { pid: 14, ppid: 1, command: 'bun scripts/check.ts --rig' },
    { pid: 15, ppid: 14, command: 'bun src/scripts/drive-core.ts' },
    { pid: 20, ppid: 1, command: 'bun server.ts' },
    { pid: 21, ppid: 1, command: 'bun src/scripts/drive-core.ts' },
    { pid: 30, ppid: 1, command: 'bun src/scripts/drive-core.ts' },
    { pid: 40, ppid: 1, command: 'bun run stop' },
    { pid: 41, ppid: 40, command: 'bun scripts/stop.ts' },
    { pid: 50, ppid: 1, command: 'ffmpeg -stream_loop -1 -re -i clip.mp4 -an -f image2pipe pipe:1' },
    { pid: 60, ppid: 1, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  ];
  const cwd: Record<number, string> = {
    10: ROOT, 11: ROOT, 12: ROOT, 13: ROOT, 14: ROOT, 15: ROOT,
    20: '/work/attune_v2', 21: '/work/some-other-project', 30: OLD_DRAFT,
    40: ROOT, 41: ROOT, 50: ROOT, 60: '/',
  };
  const targets = pickTargets(procs, (pid) => cwd[pid] ?? null, [ROOT, OLD_DRAFT], new Set([41, 40])).sort((a, b) => a - b);

  test('stops the demo, glasses app, a check run, their children, ffmpeg readers, and the old draft', () => {
    expect(targets).toEqual([10, 11, 12, 13, 14, 15, 30, 50]);
  });

  test("never touches another project's processes, even with the same command", () => {
    expect(targets).not.toContain(20);
    expect(targets).not.toContain(21);
    expect(targets).not.toContain(60);
  });

  test('never targets itself', () => {
    expect(targets).not.toContain(40);
    expect(targets).not.toContain(41);
  });

  test('`bun run stop` is not an app command even when not excluded', () => {
    const t = pickTargets([{ pid: 40, ppid: 1, command: 'bun run stop' }], () => ROOT, [ROOT], new Set());
    expect(t).toEqual([]);
  });
});

describe('underRoots', () => {
  test('matches the root and paths inside it', () => {
    expect(underRoots(ROOT, [ROOT])).toBe(true);
    expect(underRoots(`${ROOT}/src`, [ROOT])).toBe(true);
  });
  test('does not match a sibling directory that shares a prefix, or an unknown cwd', () => {
    expect(underRoots(`${ROOT}-old`, [ROOT])).toBe(false);
    expect(underRoots(null, [ROOT])).toBe(false);
  });
});
