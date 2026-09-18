// run-recorder.test.ts — one take on disk: the round trip, the append-only
// event log, frame de-duplication, retention, dropped empty runs, recovery
// after a crash, the path-traversal boundary, and "never throws into a take".
// Temp dirs only; no network.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunRecorder, isRunId, type RunMeta } from '../src/runtime/run-recorder.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'runs-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A clock the test moves by hand, so ids and durations are predictable.
function harness(keep = 40) {
  const dir = tempDir();
  const logs: string[] = [];
  let t = Date.UTC(2026, 8, 17, 14, 57, 33);
  const rec = createRunRecorder({ dir, keep, log: (m) => logs.push(m), now: () => t });
  return { dir, rec, logs, tick: (ms: number) => (t += ms), at: () => t };
}

const jpeg = (fill: number, len = 64) => Buffer.alloc(len, fill);
const lines = (dir: string, id: string) =>
  readFileSync(join(dir, id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const meta = (dir: string, id: string): RunMeta => JSON.parse(readFileSync(join(dir, id, 'run.json'), 'utf8'));

// One finished take with a single exchange; returns its id.
function take(h: ReturnType<typeof harness>, mode: 'baseline' | 'toolkit' = 'baseline'): string {
  const id = h.rec.start({ source: 'glasses', mode })!.id;
  h.rec.event({ type: 'user', text: 'hello', ts: h.at() }, { mode });
  h.tick(1000);
  h.rec.end('stopped');
  h.tick(1000);
  return id;
}

describe('run recorder', () => {
  test('start → events → end round-trips through run.json and events.jsonl', () => {
    const h = harness();
    const run = h.rec.start({ source: 'glasses', mode: 'baseline' })!;
    expect(run.id).toBe(`20260917-145733-${run.id.slice(-4)}`);
    expect(isRunId(run.id)).toBe(true);
    // Readable from the first moment: a crash now still leaves a run.
    expect(meta(h.dir, run.id).endedAt).toBeNull();

    h.rec.event({ type: 'status', text: 'Starting…', ts: h.at() }, { frame: jpeg(1), mode: 'baseline' });
    h.tick(2000);
    h.rec.event({ type: 'user', text: 'help me start the washing machine', ts: h.at() }, { frame: jpeg(1), mode: 'baseline' });
    h.tick(3000);
    const ref = h.rec.event(
      { type: 'assistant', text: 'Open the drawer.', ts: h.at() },
      { frame: jpeg(2), mode: 'toolkit', task: 'washing-machine', slower: true, rate: 0.8, deliveryMode: 'stepwise' },
    );
    h.rec.attachAudio(ref, Buffer.from('RIFFfake'));
    h.tick(5000);
    h.rec.end('stopped');

    expect(h.rec.current()).toBeNull();
    const m = meta(h.dir, run.id);
    expect(m).toMatchObject({
      source: 'glasses',
      mode: 'baseline',
      modes: ['baseline', 'toolkit'],
      task: 'washing-machine',
      firstSaid: 'help me start the washing machine',
      thumb: '1.jpg',
      endReason: 'stopped',
      durationMs: 10_000,
      counts: { userTurns: 1, guideLines: 1, frames: 2, audioClips: 1 },
    });
    expect(m.endedAt).toBe(m.startedAt + 10_000);

    const raw = lines(h.dir, run.id);
    expect(raw.map((r) => r.type)).toEqual(['status', 'user', 'assistant', 'audio']);
    expect(raw[0].frame).toBeUndefined(); // status events carry no frame
    expect(raw[1]).toMatchObject({ seq: 2, frame: '1.jpg', mode: 'baseline' });
    expect(raw[2]).toMatchObject({ seq: 3, frame: '2.jpg', slower: true, rate: 0.8, deliveryMode: 'stepwise' });
    expect(raw[3]).toEqual({ type: 'audio', for: 3, file: '3.wav' });

    // Reading joins the clip onto its line and hides the bookkeeping row.
    const read = h.rec.readRun(run.id)!;
    expect(read.events.map((e) => e.type)).toEqual(['status', 'user', 'assistant']);
    expect(read.events[2]!.audio).toBe('3.wav');
    expect(readFileSync(h.rec.audioPath(run.id, '3.wav')!, 'utf8')).toBe('RIFFfake');
    expect(h.rec.listRuns().map((r) => r.id)).toEqual([run.id]);
  });

  test('a second Start during a take keeps the same run; events outside a take go nowhere', () => {
    const h = harness();
    expect(h.rec.event({ type: 'user', text: 'too early', ts: h.at() })).toBeNull();
    const a = h.rec.start({ source: 'demo', mode: 'toolkit' })!;
    const b = h.rec.start({ source: 'demo', mode: 'baseline' })!;
    expect(b.id).toBe(a.id);
    expect(readdirSync(h.dir)).toHaveLength(1);
  });

  test('end(reason, id) only ends the run it names; a late clip never lands on a newer run', () => {
    const h = harness();
    const first = h.rec.start({ source: 'glasses', mode: 'baseline' })!;
    const ref = h.rec.event({ type: 'assistant', text: 'one', ts: h.at() });
    h.rec.end('stopped', 'not-the-id');
    expect(h.rec.current()?.id).toBe(first.id);
    h.rec.end('disconnected', first.id);
    expect(meta(h.dir, first.id).endReason).toBe('disconnected');

    h.tick(1000);
    const second = h.rec.start({ source: 'glasses', mode: 'baseline' })!;
    h.rec.attachAudio(ref, Buffer.from('late'));
    expect(readdirSync(join(h.dir, second.id, 'audio'))).toHaveLength(0);
    expect(readdirSync(join(h.dir, first.id, 'audio'))).toHaveLength(0);
  });

  test('identical frames are saved once — same buffer or same bytes', () => {
    const h = harness();
    const run = h.rec.start({ source: 'glasses', mode: 'baseline' })!;
    const same = jpeg(7);
    h.rec.event({ type: 'user', text: 'a', ts: h.at() }, { frame: same });
    h.rec.event({ type: 'assistant', text: 'b', ts: h.at() }, { frame: same }); // same reference
    h.rec.event({ type: 'user', text: 'c', ts: h.at() }, { frame: jpeg(7) }); // same bytes
    h.rec.event({ type: 'assistant', text: 'd', ts: h.at() }, { frame: jpeg(8) }); // same length, new picture
    h.rec.event({ type: 'user', text: 'e', ts: h.at() }, { frame: null }); // camera off
    expect(readdirSync(join(h.dir, run.id, 'frames')).sort()).toEqual(['1.jpg', '2.jpg']);
    expect(lines(h.dir, run.id).map((r) => r.frame)).toEqual(['1.jpg', '1.jpg', '1.jpg', '2.jpg', undefined]);
    expect(h.rec.current()!.counts.frames).toBe(2);
  });

  test('retention keeps the newest N and never deletes a live run', () => {
    const h = harness(3);
    // A run another process (or a crash) left open — older than everything.
    const orphan = '20250101-000000-live';
    mkdirSync(join(h.dir, orphan), { recursive: true });
    writeFileSync(join(h.dir, orphan, 'run.json'), JSON.stringify({ id: orphan, startedAt: 1, endedAt: null }));

    const ids = [take(h), take(h), take(h), take(h)];
    const current = h.rec.start({ source: 'glasses', mode: 'baseline' })!.id;

    const left = readdirSync(h.dir).sort();
    expect(left).toContain(orphan);
    expect(left).toContain(current);
    expect(left).toHaveLength(3);
    expect(left).toContain(ids[3]!); // the newest finished one survives
    expect(left).not.toContain(ids[0]!);
    expect(left).not.toContain(ids[2]!);
  });

  test('a run with nothing said is dropped at the end', () => {
    const h = harness();
    const run = h.rec.start({ source: 'glasses', mode: 'baseline' })!;
    h.rec.event({ type: 'status', text: 'Starting…', ts: h.at() });
    h.rec.event({ type: 'status', text: 'Stopped', ts: h.at() });
    h.rec.end('stopped');
    expect(existsSync(join(h.dir, run.id))).toBe(false);
    expect(h.rec.listRuns()).toEqual([]);
  });

  test('recover() closes runs a crash left open, up to the last thing recorded', () => {
    const h = harness();
    const run = h.rec.start({ source: 'glasses', mode: 'toolkit' })!;
    h.tick(4000);
    h.rec.event({ type: 'user', text: 'hello', ts: h.at() });
    // The process dies here. A new one boots on the same folder:
    const logs: string[] = [];
    const next = createRunRecorder({ dir: h.dir, keep: 40, log: (m) => logs.push(m) });
    next.recover();
    const m = meta(h.dir, run.id);
    expect(m.endReason).toBe('interrupted');
    expect(m.durationMs).toBe(4000);
    expect(m.endedAt).toBe(m.startedAt + 4000);
    // Finished runs are left alone.
    const before = readFileSync(join(h.dir, run.id, 'run.json'), 'utf8');
    next.recover();
    expect(readFileSync(join(h.dir, run.id, 'run.json'), 'utf8')).toBe(before);
    expect(logs).toEqual([]);
  });

  test('a half-written last line in events.jsonl does not hide the rest', () => {
    const h = harness();
    const id = take(h);
    writeFileSync(join(h.dir, id, 'events.jsonl'), readFileSync(join(h.dir, id, 'events.jsonl'), 'utf8') + '{"seq":2,"type":"assi');
    expect(h.rec.readRun(id)!.events).toHaveLength(1);
  });

  test('ids and file names from a URL cannot leave the run folder', () => {
    const h = harness();
    const run = h.rec.start({ source: 'glasses', mode: 'baseline' })!;
    const ref = h.rec.event({ type: 'assistant', text: 'hi', ts: h.at() }, { frame: jpeg(1) });
    h.rec.attachAudio(ref, Buffer.from('wav'));
    writeFileSync(join(h.dir, 'secret.jpg'), 'secret');
    writeFileSync(join(h.dir, run.id, 'frames', 'notes.txt'), 'x');

    expect(h.rec.framePath(run.id, '1.jpg')).toBe(join(h.dir, run.id, 'frames', '1.jpg'));
    expect(h.rec.audioPath(run.id, '1.wav')).toBe(join(h.dir, run.id, 'audio', '1.wav'));
    expect(h.rec.framePath(run.id, '99.jpg')).toBeNull(); // well-formed but absent

    const badFiles = ['../run.json', '../../secret.jpg', '..%2F..%2Fsecret.jpg', '%2e%2e/secret.jpg', '/etc/passwd', 'notes.txt',
      '1.jpg/../../run.json', '1.jpg\0.png', '1.wav', '', '.', '..', 'frames/1.jpg', '1.JPG', ' 1.jpg', '1234567.jpg'];
    for (const f of badFiles) expect(h.rec.framePath(run.id, f)).toBeNull();
    expect(h.rec.audioPath(run.id, '../frames/1.jpg')).toBeNull();
    expect(h.rec.audioPath(run.id, '1.jpg')).toBeNull();

    const badIds = ['..', '.', '', '../' + run.id, run.id + '/..', '/', '/etc', '%2e%2e', run.id.toUpperCase(), run.id + ' ',
      '20260917-145733-x7k', '20260917-145733-x7k2z', '20260917_145733-x7k2'];
    for (const id of badIds) {
      expect(isRunId(id)).toBe(false);
      expect(h.rec.framePath(id, '1.jpg')).toBeNull();
      expect(h.rec.readRun(id)).toBeNull();
      expect(h.rec.deleteRun(id)).toBe('missing');
    }
    expect(isRunId(undefined)).toBe(false);
    expect(isRunId(['20260917-145733-x7k2'])).toBe(false);
    expect(existsSync(join(h.dir, 'secret.jpg'))).toBe(true);
  });

  test('deleteRun removes a finished run and refuses the live one', () => {
    const h = harness();
    const done = take(h);
    const live = h.rec.start({ source: 'glasses', mode: 'baseline' })!.id;
    expect(h.rec.deleteRun(live)).toBe('live');
    expect(h.rec.deleteRun(done)).toBe('deleted');
    expect(h.rec.deleteRun(done)).toBe('missing');
    expect(h.rec.listRuns().map((r) => r.id)).toEqual([live]);
  });

  test('disk failures never throw into the take, and are logged once', () => {
    // RUNS_DIR is a FILE: nothing under it can be created.
    const dir = tempDir();
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, 'x');
    const logs: string[] = [];
    const rec = createRunRecorder({ dir: blocked, keep: 5, log: (m) => logs.push(m) });
    expect(() => rec.recover()).not.toThrow();
    expect(rec.start({ source: 'glasses', mode: 'baseline' })).toBeNull();
    expect(rec.event({ type: 'user', text: 'hi', ts: 1 })).toBeNull();
    expect(() => rec.attachAudio(null, Buffer.from('x'))).not.toThrow();
    expect(() => rec.end('stopped')).not.toThrow();
    expect(rec.listRuns()).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith('[runs] ');

    // The folder vanishes mid-take: every later write fails, quietly.
    const h = harness();
    const run = h.rec.start({ source: 'glasses', mode: 'baseline' })!;
    rmSync(join(h.dir, run.id), { recursive: true, force: true });
    expect(h.rec.event({ type: 'user', text: 'one', ts: h.at() }, { frame: jpeg(1) })).toBeNull();
    expect(h.rec.event({ type: 'assistant', text: 'two', ts: h.at() })).toBeNull();
    expect(() => h.rec.attachAudio({ runId: run.id, seq: 1 }, Buffer.from('x'))).not.toThrow();
    expect(() => h.rec.end('shutdown')).not.toThrow();
    expect(h.logs).toHaveLength(1);
  });
});
