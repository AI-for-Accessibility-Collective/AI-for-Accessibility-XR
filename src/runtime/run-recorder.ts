// Run recorder — keeps each take (one Start→Stop) on disk so it can be looked
// at afterwards: what was said, what the guide answered, what the camera saw
// at that moment and the clip that was spoken.
//
//   runs/<id>/run.json        facts about the take, rewritten as it goes
//   runs/<id>/events.jsonl    one JSON line per event, append-only
//   runs/<id>/frames/<n>.jpg  the camera frame behind a turn
//   runs/<id>/audio/<n>.wav   the spoken clip of guide line <n>
//
// Two rules shape everything here. A recording failure must never break a
// take: every disk write is wrapped, logged once and forgotten. And ids and
// file names arrive from URLs, so they are checked against strict patterns
// before they ever touch a path.
//
// Writes are synchronous on purpose: they are small, they happen a few times
// a minute, and a line that is on disk before the next event survives a crash.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

export type RunSource = 'glasses' | 'demo';
export type RunMode = 'baseline' | 'toolkit';
export type RunEndReason = 'stopped' | 'disconnected' | 'shutdown' | 'interrupted';

export interface RunMeta {
  id: string;
  startedAt: number;
  endedAt: number | null; // null while the take is still running
  endReason: RunEndReason | null;
  durationMs: number | null;
  source: RunSource;
  mode: RunMode; // the mode the take started in
  modes: RunMode[]; // every mode seen, in order of first appearance
  task: string | null;
  firstSaid: string | null; // the first thing the person said — the list's title
  thumb: string | null; // first saved frame
  counts: { userTurns: number; guideLines: number; frames: number; audioClips: number };
}

export interface RunEventInput {
  type: 'user' | 'assistant' | 'status' | 'hud';
  text: string;
  ts: number;
}

// What a host knows at the moment of an event. All optional.
export interface RunEventExtras {
  frame?: Buffer | null; // frames.latest() — saved for user/assistant events only
  mode?: RunMode;
  task?: string | null;
  // Delivery facts for a guide line, for comparing the two modes.
  slower?: boolean;
  rate?: number;
  deliveryMode?: 'continuous' | 'stepwise';
}

export interface RunEvent extends RunEventInput {
  seq: number;
  mode?: RunMode;
  frame?: string;
  audio?: string;
  slower?: boolean;
  rate?: number;
  deliveryMode?: 'continuous' | 'stepwise';
}

// Returned by event() so a clip that arrives later lands on the right line of
// the right run — never on a newer run that started meanwhile.
export interface RunEventRef {
  runId: string;
  seq: number;
}

export interface RunRecorderOptions {
  dir: string;
  keep: number;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface RunRecorder {
  // Marks runs a crash left open as interrupted. Call once at boot.
  recover(): void;
  // Begins a run; while one is already running it is returned unchanged.
  start(info: { source: RunSource; mode: RunMode; task?: string | null }): RunMeta | null;
  event(e: RunEventInput, extras?: RunEventExtras): RunEventRef | null;
  attachAudio(ref: RunEventRef | null, wav: Uint8Array | null | undefined): void;
  // Ends the running take. With `id`, only if that is the one running.
  end(reason: RunEndReason, id?: string): void;
  current(): RunMeta | null;
  listRuns(): RunMeta[]; // newest first
  readRun(id: string): { run: RunMeta; events: RunEvent[] } | null;
  deleteRun(id: string): 'deleted' | 'missing' | 'live';
  framePath(id: string, file: string): string | null;
  audioPath(id: string, file: string): string | null;
}

const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
const FRAME_FILE_RE = /^\d{1,6}\.jpg$/;
const AUDIO_FILE_RE = /^\d{1,6}\.wav$/;

export function isRunId(id: unknown): id is string {
  return typeof id === 'string' && RUN_ID_RE.test(id);
}

// UTC timestamp + a short random tail: sorts by start time, safe in a path
// and in a URL.
function newRunId(at: number): string {
  const d = new Date(at).toISOString(); // 2026-09-17T14:57:33.123Z
  const stamp = `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}`;
  let tail = '';
  while (tail.length < 4) tail += Math.floor(Math.random() * 36).toString(36);
  return `${stamp}-${tail}`;
}

export function createRunRecorder(opts: RunRecorderOptions): RunRecorder {
  const root = resolve(opts.dir);
  const keep = Math.max(1, Math.floor(opts.keep) || 1);
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const now = opts.now ?? Date.now;

  let cur: RunMeta | null = null;
  let seq = 0;
  let frameNo = 0;
  let lastFrame: Buffer | null = null;
  let lastFrameFile: string | null = null;
  let warned = false;

  // Every write goes through here: one warning per run, then silence.
  function safe<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned) {
        warned = true;
        log(`[runs] ${what} failed — this take may be missing from the run history: ${e instanceof Error ? e.message : String(e)}`);
      }
      return undefined;
    }
  }

  const runDir = (id: string): string => join(root, id);

  // Write-then-rename, so a crash mid-write never leaves half a run.json.
  function writeMeta(meta: RunMeta): void {
    const file = join(runDir(meta.id), 'run.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(meta, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  function readMeta(id: string): RunMeta | null {
    try {
      const meta = JSON.parse(readFileSync(join(runDir(id), 'run.json'), 'utf8')) as RunMeta;
      return meta && meta.id === id ? meta : null;
    } catch {
      return null;
    }
  }

  function runIds(): string[] {
    try {
      return readdirSync(root).filter(isRunId).sort();
    } catch {
      return [];
    }
  }

  function readEvents(id: string): RunEvent[] {
    let raw = '';
    try {
      raw = readFileSync(join(runDir(id), 'events.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const events: RunEvent[] = [];
    const bySeq = new Map<number, RunEvent>();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a line cut short by a crash
      }
      // The clip is ready after its line was written, and the log is
      // append-only, so it comes as a row of its own and is joined here.
      if (row?.type === 'audio') {
        const target = bySeq.get(row.for);
        if (target && typeof row.file === 'string' && AUDIO_FILE_RE.test(row.file)) target.audio = row.file;
        continue;
      }
      if (typeof row?.seq !== 'number' || typeof row?.text !== 'string') continue;
      events.push(row as RunEvent);
      bySeq.set(row.seq, row as RunEvent);
    }
    return events;
  }

  // Oldest finished runs go first. A run without endedAt is live (or waiting
  // for recover()) and is never touched.
  function prune(): void {
    const ids = runIds();
    let extra = ids.length - keep;
    for (const id of ids) {
      if (extra <= 0) break;
      if (id === cur?.id) continue;
      const meta = readMeta(id);
      if (meta && meta.endedAt == null) continue;
      rmSync(runDir(id), { recursive: true, force: true });
      extra--;
    }
  }

  function resolveIn(id: string, sub: 'frames' | 'audio', file: string, pattern: RegExp): string | null {
    if (!isRunId(id) || typeof file !== 'string' || !pattern.test(file)) return null;
    const base = resolve(runDir(id), sub);
    const full = resolve(base, file);
    // Belt and braces: the patterns above already rule out separators and dots.
    if (!full.startsWith(base + sep)) return null;
    return existsSync(full) ? full : null;
  }

  return {
    recover() {
      safe('recovering interrupted runs', () => {
        for (const id of runIds()) {
          if (id === cur?.id) continue;
          const meta = readMeta(id);
          if (!meta || meta.endedAt != null) continue;
          const events = readEvents(id);
          const last = events.length ? events[events.length - 1]!.ts : meta.startedAt;
          meta.endedAt = Math.max(meta.startedAt, last);
          meta.durationMs = meta.endedAt - meta.startedAt;
          meta.endReason = 'interrupted';
          writeMeta(meta);
        }
      });
    },

    start(info) {
      if (cur) return cur;
      warned = false;
      return (
        safe('starting a run', () => {
          const startedAt = now();
          let id = newRunId(startedAt);
          while (existsSync(runDir(id))) id = newRunId(startedAt);
          const meta: RunMeta = {
            id,
            startedAt,
            endedAt: null,
            endReason: null,
            durationMs: null,
            source: info.source,
            mode: info.mode,
            modes: [info.mode],
            task: info.task ?? null,
            firstSaid: null,
            thumb: null,
            counts: { userTurns: 0, guideLines: 0, frames: 0, audioClips: 0 },
          };
          mkdirSync(join(runDir(id), 'frames'), { recursive: true });
          mkdirSync(join(runDir(id), 'audio'), { recursive: true });
          writeMeta(meta);
          cur = meta;
          seq = 0;
          frameNo = 0;
          lastFrame = null;
          lastFrameFile = null;
          safe('removing old runs', prune);
          return meta;
        }) ?? null
      );
    },

    event(e, extras = {}) {
      const run = cur;
      if (!run) return null;
      return (
        safe('recording an event', () => {
          const row: RunEvent = { seq: ++seq, type: e.type, text: String(e.text ?? ''), ts: e.ts };
          const turn = e.type === 'user' || e.type === 'assistant';
          let dirty = false;

          if (extras.mode) {
            row.mode = extras.mode;
            if (!run.modes.includes(extras.mode)) {
              run.modes.push(extras.mode);
              dirty = true;
            }
          }
          if (extras.task && extras.task !== run.task) {
            run.task = extras.task;
            dirty = true;
          }

          if (turn && extras.frame && extras.frame.length > 0) {
            const frame = extras.frame;
            // The camera runs at a few frames a second; two turns close
            // together often see the very same JPEG — keep it once.
            const same =
              lastFrame != null && (lastFrame === frame || (lastFrame.length === frame.length && lastFrame.equals(frame)));
            if (!same || !lastFrameFile) {
              const file = `${++frameNo}.jpg`;
              writeFileSync(join(runDir(run.id), 'frames', file), frame);
              lastFrame = frame;
              lastFrameFile = file;
              run.counts.frames++;
              if (!run.thumb) run.thumb = file;
            }
            row.frame = lastFrameFile;
          }

          if (e.type === 'assistant') {
            if (typeof extras.slower === 'boolean') row.slower = extras.slower;
            if (typeof extras.rate === 'number' && Number.isFinite(extras.rate)) row.rate = extras.rate;
            if (extras.deliveryMode) row.deliveryMode = extras.deliveryMode;
            run.counts.guideLines++;
          } else if (e.type === 'user') {
            run.counts.userTurns++;
            if (!run.firstSaid) run.firstSaid = row.text.slice(0, 200);
          }

          appendFileSync(join(runDir(run.id), 'events.jsonl'), JSON.stringify(row) + '\n');
          if (turn || dirty) writeMeta(run);
          return { runId: run.id, seq: row.seq };
        }) ?? null
      );
    },

    attachAudio(ref, wav) {
      const run = cur;
      if (!run || !ref || ref.runId !== run.id || !wav || wav.length === 0) return;
      safe('saving a spoken clip', () => {
        const file = `${ref.seq}.wav`;
        writeFileSync(join(runDir(run.id), 'audio', file), wav);
        appendFileSync(join(runDir(run.id), 'events.jsonl'), JSON.stringify({ type: 'audio', for: ref.seq, file }) + '\n');
        run.counts.audioClips++;
        writeMeta(run);
      });
    },

    end(reason, id) {
      const run = cur;
      if (!run || (id != null && id !== run.id)) return;
      cur = null;
      lastFrame = null;
      safe('ending a run', () => {
        // Start then Stop with nothing said: an accident, not a take.
        if (run.counts.userTurns === 0 && run.counts.guideLines === 0) {
          rmSync(runDir(run.id), { recursive: true, force: true });
          return;
        }
        run.endedAt = Math.max(now(), run.startedAt);
        run.durationMs = run.endedAt - run.startedAt;
        run.endReason = reason;
        writeMeta(run);
      });
    },

    current() {
      return cur;
    },

    listRuns() {
      const out: RunMeta[] = [];
      for (const id of runIds().reverse()) {
        const meta = readMeta(id);
        if (meta) out.push(meta);
      }
      return out;
    },

    readRun(id) {
      if (!isRunId(id)) return null;
      const run = readMeta(id);
      return run ? { run, events: readEvents(id) } : null;
    },

    deleteRun(id) {
      if (!isRunId(id) || !existsSync(runDir(id))) return 'missing';
      if (id === cur?.id) return 'live';
      try {
        rmSync(runDir(id), { recursive: true, force: true });
        return 'deleted';
      } catch (e) {
        log(`[runs] could not delete ${id}: ${e instanceof Error ? e.message : String(e)}`);
        return 'missing';
      }
    },

    framePath: (id, file) => resolveIn(id, 'frames', file, FRAME_FILE_RE),
    audioPath: (id, file) => resolveIn(id, 'audio', file, AUDIO_FILE_RE),
  };
}
