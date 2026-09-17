// Generic RTMP -> JPEG frame extraction + a small recent-frame ring.
// No Mentra dependency. Ported from tdbank (startLocalFrameCapture +
// agent.ts frame ring): ffmpeg reads the local RTMP stream and pipes MJPEG;
// we split frames on JPEG SOI/EOI markers, dedupe identical frames, and keep
// the last N for the engine to look at.

import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { getPlayUrl } from './rtmp.ts';

export interface FrameEntry {
  jpeg: Buffer;
  timestamp: number;
}

// Holds the most recent frames. The conversational + proactive paths both
// read from here, so frame capture stays decoupled from what consumes it.
export class FrameStore {
  private ring: FrameEntry[] = [];
  private lastHash: string | null = null;
  // Pending captureNext() requests waiting for FRESH frames pushed after the call.
  private waiters: Array<{ need: number; got: FrameEntry[]; finish: (f: FrameEntry[]) => void }> = [];

  constructor(private readonly ringSize: number) {}

  push(jpeg: Buffer): void {
    const hash = createHash('sha1').update(jpeg).digest('hex').slice(0, 16);
    if (hash === this.lastHash) return; // skip duplicate/static frames
    this.lastHash = hash;
    const entry: FrameEntry = { jpeg, timestamp: Date.now() };
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.shift();
    // Feed any in-flight captureNext() requests with this fresh frame.
    for (const w of [...this.waiters]) {
      w.got.push(entry);
      if (w.got.length >= w.need) w.finish(w.got);
    }
  }

  recent(): FrameEntry[] {
    return [...this.ring];
  }

  // Capture the next `n` FRESH frames pushed AFTER this call — i.e. aligned to
  // "now" (the moment the wearer asks to read what they're pointing at / holding
  // up), instead of the possibly-stale ring. Resolves early once `n` arrive, or
  // at `timeoutMs`. Falls back to recent() if no fresh frame appears (e.g. a
  // perfectly static scene whose duplicate frames are deduped away).
  captureNext(n: number, timeoutMs = 3500): Promise<FrameEntry[]> {
    return new Promise((resolve) => {
      let settled = false;
      const w = { need: n, got: [] as FrameEntry[], finish: (_: FrameEntry[]) => {} };
      const done = (frames: FrameEntry[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(frames.length ? frames : this.recent());
      };
      w.finish = done;
      const timer = setTimeout(() => done(w.got), timeoutMs);
      this.waiters.push(w);
    });
  }

  latest(): Buffer | null {
    return this.ring.length ? this.ring[this.ring.length - 1]!.jpeg : null;
  }

  // Drop all buffered frames (e.g. when switching video source) so a stale
  // frame from the old source never lingers on the feed. Resets the dedup hash
  // so the first frame of the new source is always accepted.
  clear(): void {
    this.ring = [];
    this.lastHash = null;
  }

  get size(): number {
    return this.ring.length;
  }
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

// Split an MJPEG byte stream into individual JPEG frames on SOI/EOI markers.
// Returns a stdout 'data' handler that maintains its own running buffer, so
// both the RTMP and file capture paths share one parser. Make a fresh one per
// ffmpeg spawn (leftover partial bytes from a dead process must not carry over).
function makeJpegSplitter(onFrame: (jpeg: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const soi = buf.indexOf(JPEG_SOI);
      if (soi === -1) break;
      const eoi = buf.indexOf(JPEG_EOI, soi + 2);
      if (eoi === -1) break;
      const frame = buf.subarray(soi, eoi + 2);
      buf = buf.subarray(eoi + 2);
      if (frame.length < 1000) continue; // skip truncated/garbage frames
      onFrame(Buffer.from(frame));
    }
  };
}

// Spawns ffmpeg against the local RTMP stream and calls onFrame(jpeg) for
// each decoded frame. Auto-respawns ffmpeg if the stream drops. Returns a
// stop handle.
export function startFrameCapture(opts: {
  rtmpPort: number;
  captureFps: number;
  onFrame: (jpeg: Buffer) => void;
}): { stop: () => void } {
  const playUrl = getPlayUrl(opts.rtmpPort);
  let stopped = false;
  let frameCount = 0;
  let proc: ChildProcess | null = null;

  console.log(`  [frames] capturing from ${playUrl} @ ${opts.captureFps} fps`);

  function spawnFfmpeg(): void {
    if (stopped) return;
    proc = spawn(
      'ffmpeg',
      [
        '-loglevel', 'warning',
        '-rtmp_live', 'live',
        // Keep ingest low-latency: a clean H264 RTMP stream advertises its
        // format in the first keyframe, so the old 20s/20MB probe window was
        // pure added lag. Slash it and add low_delay (nobuffer is already set).
        '-analyzeduration', '1000000',
        '-probesize', '500000',
        '-fflags', '+discardcorrupt+nobuffer',
        '-flags', 'low_delay',
        '-rw_timeout', '15000000',
        '-i', playUrl,
        '-an',
        '-r', String(opts.captureFps),
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '2',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    proc.stdout!.on('data', makeJpegSplitter((frame) => {
      frameCount++;
      opts.onFrame(frame);
    }));

    proc.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !stopped && !msg.includes('Input/output error')) {
        console.log(`  [ffmpeg] ${msg}`);
      }
    });

    proc.on('exit', () => {
      proc = null;
      if (!stopped) setTimeout(spawnFfmpeg, 3000);
    });
    proc.on('error', (err) => {
      console.error('  [ffmpeg] spawn error:', err.message);
      proc = null;
      if (!stopped) setTimeout(spawnFfmpeg, 3000);
    });
  }

  spawnFfmpeg();

  return {
    stop: () => {
      stopped = true;
      if (proc) {
        proc.kill('SIGTERM');
        const p = proc;
        setTimeout(() => {
          try {
            p.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 2000);
        proc = null;
      }
      console.log(`  [frames] stopped (${frameCount} frames captured)`);
    },
  };
}

// Decode a local VIDEO FILE (e.g. a clip recorded on the glasses) into frames,
// reusing the exact same MJPEG -> JPEG path as the RTMP capture. No RTMP server
// or network involved. Defaults to real-time playback (-re) so frames arrive at
// ~captureFps as they would live, and loops so a recent frame is always
// available while you test. This is the easiest way to exercise the full
// FrameStore -> orchestrator -> engine -> skills pipeline against real footage.
export function startFileFrameCapture(opts: {
  file: string;
  captureFps: number;
  loop?: boolean; // default true
  realtime?: boolean; // default true (-re: emit at ~captureFps in real time)
  onFrame: (jpeg: Buffer) => void;
  onEnd?: () => void; // fired when a non-looping file finishes
}): { stop: () => void } {
  const loop = opts.loop ?? true;
  const realtime = opts.realtime ?? true;
  let stopped = false;
  let frameCount = 0;
  let proc: ChildProcess | null = null;

  console.log(`  [frames] decoding ${opts.file} @ ${opts.captureFps} fps${loop ? ' (looping)' : ''}`);

  proc = spawn(
    'ffmpeg',
    [
      '-loglevel', 'warning',
      ...(loop ? ['-stream_loop', '-1'] : []),
      ...(realtime ? ['-re'] : []),
      '-i', opts.file,
      '-an',
      '-r', String(opts.captureFps),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '2',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  proc.stdout!.on('data', makeJpegSplitter((frame) => {
    frameCount++;
    opts.onFrame(frame);
  }));
  proc.stderr!.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && !stopped && !msg.includes('Input/output error')) console.log(`  [ffmpeg] ${msg}`);
  });
  proc.on('exit', () => {
    proc = null;
    if (!stopped) {
      console.log(`  [frames] file finished (${frameCount} frames)`);
      opts.onEnd?.();
    }
  });
  proc.on('error', (err) => {
    console.error('  [ffmpeg] spawn error:', err.message);
    proc = null;
    if (!stopped) opts.onEnd?.();
  });

  return {
    stop: () => {
      stopped = true;
      if (proc) {
        proc.kill('SIGTERM');
        const p = proc;
        setTimeout(() => {
          try {
            p.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 2000);
        proc = null;
      }
      console.log(`  [frames] stopped (${frameCount} frames captured)`);
    },
  };
}
