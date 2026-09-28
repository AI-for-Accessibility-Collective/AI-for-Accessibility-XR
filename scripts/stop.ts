#!/usr/bin/env bun
// bun run stop — stop everything this app runs on this machine, then prove
// nothing is left that could call Gemini.
//
// Stops: the demo harness (bun run demo), the glasses app (bun run start /
// dev), a check or model-bench run, the scripts they spawn, and their ffmpeg
// video readers — plus the OLD draft's wearable demo, which calls Gemini too.
// Each process gets SIGTERM (which the demo and the glasses app turn into a
// clean shutdown that halts Gemini first), then SIGKILL if it hasn't exited.
//
// Then verifies: none of those processes remain, nothing of ours listens on
// the app's ports, and no bun/node/ffmpeg process is connected to Google.
// Exits 1 if anything of ours is still running. It cannot reach a server
// deployed elsewhere — stop those on their own machine.

import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { config } from '../src/config.ts';

const ROOT = resolve(import.meta.dir, '..');
const OLD_DRAFT = resolve(ROOT, '../../AI-for-Accessibility-Toolkit-Draft/wearable');
const ROOTS = [ROOT, OLD_DRAFT];
const PORTS = [...new Set([config.port, config.demoPort, config.rtmpPort, config.rtmpPort + 7000, 3900, 3901, 3910, 3911, 3912, 3913])];

export interface Proc {
  pid: number;
  ppid: number;
  command: string;
}

const APP_COMMAND =
  /(?:^|[\s/])(?:src\/scripts\/drive-core\.ts|src\/index\.ts|scripts\/check\.ts|scripts\/bench-models\.ts|scripts\/import-profile\.mjs|src\/scripts\/probe-live-video\.ts)\b|\bbun (?:run|--hot) (?:demo|start|dev|check)\b/;
const VIDEO_READER = /\bffmpeg\b.*\bimage2pipe\b/;

export function underRoots(path: string | null, roots: string[]): boolean {
  return !!path && roots.some((r) => path === r || path.startsWith(r + sep));
}

// Pure selection, so it can be tested without real processes: app commands
// running from one of `roots`, ffmpeg video readers running from one of them,
// and every descendant of those — never `exclude` (this script and its parents).
export function pickTargets(procs: Proc[], cwdOf: (pid: number) => string | null, roots: string[], exclude: Set<number>): number[] {
  const direct = procs
    .filter((p) => !exclude.has(p.pid) && (APP_COMMAND.test(p.command) || VIDEO_READER.test(p.command)))
    .filter((p) => underRoots(cwdOf(p.pid), roots))
    .map((p) => p.pid);
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const found = new Set(direct);
  const stack = [...direct];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (!found.has(child) && !exclude.has(child)) {
        found.add(child);
        stack.push(child);
      }
    }
  }
  return [...found];
}

function listProcesses(): Proc[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
}

function cwdOf(pid: number): string | null {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lsofLines(args: string[]): string[] {
  try {
    return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').slice(1).filter(Boolean);
  } catch {
    return []; // lsof exits 1 when nothing matches
  }
}

if (import.meta.main) {
  const procs = listProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const self = new Set<number>();
  for (let pid: number | undefined = process.pid; pid && byPid.has(pid) && !self.has(pid); pid = byPid.get(pid)?.ppid) self.add(pid);

  const targets = pickTargets(procs, cwdOf, ROOTS, self);
  if (!targets.length) {
    console.log('Nothing from AI for Accessibility XR (or the old wearable draft) was running.');
  } else {
    console.log(`Stopping ${targets.length} process${targets.length === 1 ? '' : 'es'}:`);
    for (const pid of targets) console.log(`  ${pid}  ${byPid.get(pid)?.command.slice(0, 110)}`);
    // Children first, so a parent's clean shutdown isn't racing its own readers.
    for (const pid of [...targets].reverse()) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + 5000;
    while (targets.some(alive) && Date.now() < deadline) await Bun.sleep(100);
    for (const pid of targets.filter(alive)) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`  ${pid} did not exit in 5 s — killed`);
      } catch {
        /* exited meanwhile */
      }
    }
    await Bun.sleep(200);
  }

  // ---- verify --------------------------------------------------------------------
  const remaining = pickTargets(listProcesses(), cwdOf, ROOTS, self).filter(alive);
  const listeners = lsofLines(['-nP', '-iTCP', '-sTCP:LISTEN'])
    .filter((l) => PORTS.some((port) => l.includes(`:${port} `)))
    .filter((l) => underRoots(cwdOf(Number(l.trim().split(/\s+/)[1])), ROOTS));
  const google = lsofLines(['-iTCP', '-sTCP:ESTABLISHED', '-P'])
    .filter((l) => /^(bun|node|ffmpeg)\b/i.test(l))
    .filter((l) => /google|1e100/i.test(l));
  const ourGoogle = google.filter((l) => underRoots(cwdOf(Number(l.trim().split(/\s+/)[1])), ROOTS));
  const otherGoogle = google.filter((l) => !ourGoogle.includes(l));

  console.log('');
  if (remaining.length) console.log(`✗ still running: ${remaining.join(', ')}`);
  if (listeners.length) console.log(`✗ still listening:\n  ${listeners.join('\n  ')}`);
  if (ourGoogle.length) console.log(`✗ still connected to Google:\n  ${ourGoogle.join('\n  ')}`);
  if (otherGoogle.length) {
    console.log(`! other bun/node processes (not this app) are connected to Google:\n  ${otherGoogle.join('\n  ')}`);
  }
  if (remaining.length || listeners.length || ourGoogle.length) process.exit(1);
  console.log('✓ Stopped. Nothing from this app is running, listening, or connected to Google — it cannot call Gemini.');
}
