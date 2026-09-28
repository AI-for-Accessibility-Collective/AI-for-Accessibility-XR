import { describe, expect, test } from 'bun:test';
import { solveLag, VOICE_PATH_MS } from '../src/transport/camera-lag.ts';

// A camera sampled every `interval` ms, seeing flashes that reach it `delay`
// ms after they happen and last `flashMs`. `phase` shifts the sampling grid.
function simulate(opts: { delay: number; interval: number; flashMs: number; flashes: number[]; phase?: number; dark?: number; light?: number; jitter?: number }) {
  const frames: Array<{ at: number; luma: number }> = [];
  const end = Math.max(...opts.flashes) + opts.delay + 3000;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let t = opts.phase ?? 0; t < end; t += opts.interval) {
    const lit = opts.flashes.some((f) => t >= f + opts.delay && t < f + opts.delay + opts.flashMs);
    frames.push({ at: t + (opts.jitter ?? 0) * rand(), luma: lit ? (opts.light ?? 200) : (opts.dark ?? 30) });
  }
  return frames;
}
const flashes = [2000, 4300, 6100, 8600, 10400, 12900];

describe('solveLag', () => {
  test('recovers the video delay within a frame interval, across sampling phases', () => {
    for (const delay of [600, 1400, 2500]) {
      for (const phase of [0, 110, 220]) {
        const r = solveLag(simulate({ delay, interval: 333, flashMs: 600, flashes, phase }), flashes, 333, 600);
        expect(r.ok).toBe(true);
        expect(Math.abs(r.videoMs! - delay)).toBeLessThanOrEqual(200);
        expect(r.lagMs).toBe(Math.max(0, r.videoMs! - VOICE_PATH_MS));
        expect(r.samples).toBeGreaterThanOrEqual(5);
      }
    }
  });

  test('tolerates jittery frame arrival', () => {
    const r = solveLag(simulate({ delay: 1200, interval: 333, flashMs: 600, flashes, jitter: 80 }), flashes, 333, 600);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.videoMs! - 1200)).toBeLessThanOrEqual(250);
  });

  test('works through auto-exposure that compresses the contrast', () => {
    const r = solveLag(simulate({ delay: 900, interval: 333, flashMs: 600, flashes, dark: 90, light: 140 }), flashes, 333, 600);
    expect(r.ok).toBe(true);
  });

  test('says why when the camera never saw the screen', () => {
    const r = solveLag(simulate({ delay: 900, interval: 333, flashMs: 600, flashes, dark: 80, light: 85 }), flashes, 333, 600);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/never saw the screen flash/);
  });

  test('says why when there were no frames', () => {
    expect(solveLag([], flashes, 333, 600)).toMatchObject({ ok: false, reason: expect.stringMatching(/No camera frames/) });
  });

  test('refuses a result built on too few flashes', () => {
    const seenOnly = flashes.slice(0, 2);
    const r = solveLag(simulate({ delay: 900, interval: 333, flashMs: 600, flashes: seenOnly }), flashes, 333, 600);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Only 2 of 6/);
  });

  test('a delay longer than the gap between flashes is not mis-paired', () => {
    // 2.5 s delay with flashes ~2 s apart: each flash must pair with its own frames.
    const r = solveLag(simulate({ delay: 2500, interval: 333, flashMs: 600, flashes }), flashes, 333, 600);
    expect(r.ok).toBe(true);
    expect(r.spreadMs!).toBeLessThan(700);
  });
});
