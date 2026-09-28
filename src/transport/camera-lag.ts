// Measuring how far the camera runs behind.
//
// A turn is answered from the frame the wearer was looking at when they began
// to speak (frames.ts, pin). Picking that frame needs one number: how much
// later a moment's VIDEO reaches this server than the same moment's VOICE.
//
//   lag = video delay − voice delay
//
// The video delay (glasses encoder → Wi-Fi → RTMP → ffmpeg → here) is the big
// unknown — anything from half a second to several — and it can be measured
// exactly: the phone flashes its screen white at instants it reports on this
// server's clock, the wearer points the glasses at the screen, and the frames
// that come back bright say when each flash arrived.
//
// The voice delay (glasses mic → Bluetooth LE audio → phone → WebSocket) has
// no such trick available: a test sound from the phone plays through the
// glasses' own speaker over Bluetooth, which adds a delay of its own. It is
// small and steady, so it is an allowance, stated here rather than hidden
// (VOICE_PATH_MS).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const VOICE_PATH_MS = 250;

// Mean brightness (0–255) of a JPEG, via ffmpeg: scaled to 8×8 grey, averaged.
export function brightness(jpeg: Buffer): Promise<number | null> {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-vf', 'scale=8:8,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const out: Buffer[] = [];
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.on('error', () => resolve(null));
    ff.on('close', () => {
      const px = Buffer.concat(out);
      if (!px.length) return resolve(null);
      let sum = 0;
      for (const v of px) sum += v;
      resolve(sum / px.length);
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(jpeg);
  });
}

export interface LagResult {
  ok: boolean;
  // Present when ok.
  videoMs?: number; // measured: flash on the phone → bright frame here
  lagMs?: number; // what frames.pin() should add to a moment of speech
  samples?: number; // flashes that were seen
  spreadMs?: number; // how far the samples disagree (max − min)
  reason?: string; // when not ok, in words the wearer can act on
}

// Pure: frame brightness readings + the instants the phone flashed (both on
// this server's clock) → the delay. `frameIntervalMs` is the gap between
// captured frames: a flash is caught, on average, half an interval after it
// began, so that half is taken back off.
export function solveLag(
  frames: Array<{ at: number; luma: number }>,
  flashesAt: number[],
  frameIntervalMs: number,
  flashMs: number,
): LagResult {
  if (frames.length < 6) return { ok: false, reason: 'No camera frames arrived. Press Start and check the glasses are on Wi-Fi.' };
  const lumas = frames.map((f) => f.luma);
  const lo = Math.min(...lumas);
  const hi = Math.max(...lumas);
  if (hi - lo < 25) return { ok: false, reason: 'The camera never saw the screen flash. Hold the phone about a hand away, filling the view, and try again.' };
  const bright = (l: number): boolean => l > lo + (hi - lo) * 0.5;

  // Every dark→bright edge in the frames.
  const edges: number[] = [];
  for (let i = 1; i < frames.length; i++) if (bright(frames[i]!.luma) && !bright(frames[i - 1]!.luma)) edges.push(frames[i]!.at);

  // The flashes are unevenly spaced, so only ONE delay lines them all up with
  // the edges. Try every delay an edge/flash pair suggests and keep the one
  // that explains the most flashes — this holds even when the delay is longer
  // than the gap between flashes, where pairing each flash with "the next
  // bright frame" would pair it with a neighbour's.
  const TOLERANCE_MS = frameIntervalMs + 120;
  let delays: number[] = [];
  for (const e of edges) {
    for (const f of flashesAt) {
      const d = e - f;
      if (d < 0 || d > 8000) continue;
      const matched: number[] = [];
      for (const flash of flashesAt) {
        let best: number | null = null;
        for (const edge of edges) {
          const off = edge - flash - d;
          if (Math.abs(off) <= TOLERANCE_MS && (best == null || Math.abs(off) < Math.abs(best - flash - d))) best = edge;
        }
        if (best != null) matched.push(best - flash);
      }
      if (matched.length > delays.length) delays = matched;
    }
  }
  if (delays.length < 3) return { ok: false, reason: `Only ${delays.length} of ${flashesAt.length} flashes were seen. Keep the glasses pointed at the screen for the whole test.` };

  delays.sort((a, b) => a - b);
  const median = delays[Math.floor(delays.length / 2)]!;
  // Caught on average half a frame interval after the flash began (less when
  // the flash is shorter than the interval and only some frames can catch it).
  const videoMs = Math.max(0, Math.round(median - Math.min(frameIntervalMs, flashMs) / 2));
  return {
    ok: true,
    videoMs,
    lagMs: Math.max(0, videoMs - VOICE_PATH_MS),
    samples: delays.length,
    spreadMs: Math.round(delays[delays.length - 1]! - delays[0]!),
  };
}

// The measured lag outlives a restart; FRAME_LAG_MS is only the starting guess.
export function loadLag(file: string, fallbackMs: number): number {
  try {
    if (existsSync(file)) {
      const v = Number(JSON.parse(readFileSync(file, 'utf8')).lagMs);
      if (Number.isFinite(v) && v >= 0 && v < 10_000) return v;
    }
  } catch {
    /* unreadable: use the default */
  }
  return fallbackMs;
}

export function saveLag(file: string, result: LagResult): void {
  try {
    writeFileSync(file, JSON.stringify({ ...result, measuredAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) {
    console.warn('[lag] could not save the measurement:', e instanceof Error ? e.message : e);
  }
}
