import { describe, expect, test } from 'bun:test';
import { createSegmenter, MIC_SAMPLE_RATE } from '../src/engine/stt.ts';

const BYTES_PER_MS = (MIC_SAMPLE_RATE * 2) / 1000;

function silence(ms: number): Buffer {
  return Buffer.alloc(ms * BYTES_PER_MS);
}

// A 200 Hz tone, loud enough to count as speech.
function tone(ms: number, amplitude = 8000): Buffer {
  const samples = (ms * MIC_SAMPLE_RATE) / 1000;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 200 * i) / MIC_SAMPLE_RATE)), i * 2);
  }
  return buf;
}

function collect(opts = {}) {
  const out: Buffer[] = [];
  const seg = createSegmenter((pcm) => out.push(pcm), opts);
  return { out, seg };
}

describe('utterance segmenter', () => {
  test('silence alone produces nothing', () => {
    const { out, seg } = collect();
    seg.push(silence(5000));
    expect(out.length).toBe(0);
  });

  test('speech followed by silence becomes one utterance, with pre-roll and most of the tail cut', () => {
    const { out, seg } = collect();
    seg.push(silence(1000));
    seg.push(tone(800));
    seg.push(silence(1500));
    expect(out.length).toBe(1);
    const ms = out[0]!.length / BYTES_PER_MS;
    expect(ms).toBeGreaterThanOrEqual(800 + 250); // the speech plus pre-roll
    expect(ms).toBeLessThan(800 + 300 + 300); // not the whole closing silence
  });

  test('a short pause inside a sentence does not split it', () => {
    const { out, seg } = collect();
    seg.push(tone(500));
    seg.push(silence(400));
    seg.push(tone(500));
    seg.push(silence(1200));
    expect(out.length).toBe(1);
  });

  test('two sentences a long pause apart are two utterances', () => {
    const { out, seg } = collect();
    seg.push(tone(500));
    seg.push(silence(1200));
    seg.push(tone(500));
    seg.push(silence(1200));
    expect(out.length).toBe(2);
  });

  test('a click is ignored', () => {
    const { out, seg } = collect();
    seg.push(silence(500));
    seg.push(tone(40));
    seg.push(silence(1500));
    expect(out.length).toBe(0);
  });

  test('quiet line noise is ignored', () => {
    const { out, seg } = collect();
    seg.push(tone(2000, 100));
    seg.push(silence(1500));
    expect(out.length).toBe(0);
  });

  test('someone who never stops talking is cut at the limit', () => {
    const { out, seg } = collect({ maxUtteranceMs: 2000 });
    seg.push(tone(5000));
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]!.length / BYTES_PER_MS).toBeLessThanOrEqual(2000);
  });

  test('audio arriving in odd-sized chunks gives the same result', () => {
    const { out, seg } = collect();
    const all = Buffer.concat([silence(300), tone(700), silence(1200)]);
    for (let i = 0; i < all.length; i += 333) seg.push(all.subarray(i, i + 333));
    expect(out.length).toBe(1);
  });

  test('reset throws away a half-heard utterance', () => {
    const { out, seg } = collect();
    seg.push(tone(600));
    seg.reset();
    seg.push(silence(1500));
    expect(out.length).toBe(0);
  });
});

describe('tentative end-of-speech', () => {
  function collectEvents(opts = {}) {
    const log: string[] = [];
    const seg = createSegmenter(
      {
        onTentative: (pcm) => log.push(`tentative ${(pcm.length / BYTES_PER_MS).toFixed(0)}ms`),
        onTentativeWithdrawn: () => log.push('withdrawn'),
        onUtterance: (pcm, held) => log.push(`utterance ${(pcm.length / BYTES_PER_MS).toFixed(0)}ms held=${held}`),
      },
      { tentativeSilenceMs: 400, ...opts },
    );
    return { log, seg };
  }

  test('a guess is made at the short silence and held when the person stays quiet', () => {
    const { log, seg } = collectEvents();
    seg.push(tone(600));
    seg.push(silence(1500));
    expect(log[0]).toMatch(/^tentative/);
    expect(log[1]).toMatch(/^utterance .* held=true$/);
    // The guess and the final utterance carry the same audio (speech + a short tail).
    expect(log[0]!.replace(/\D/g, '')).toBe(log[1]!.match(/utterance (\d+)ms/)![1]!);
  });

  test('the guess is withdrawn when the person goes on talking', () => {
    const { log, seg } = collectEvents();
    seg.push(tone(600));
    seg.push(silence(500));
    seg.push(tone(600));
    seg.push(silence(1500));
    expect(log).toEqual([expect.stringMatching(/^tentative/), 'withdrawn', expect.stringMatching(/^tentative/), expect.stringMatching(/held=true$/)]);
  });

  test('without the option nothing tentative happens', () => {
    const log: string[] = [];
    const seg = createSegmenter({ onTentative: () => log.push('tentative'), onUtterance: (_p, held) => log.push(`utterance held=${held}`) });
    seg.push(tone(600));
    seg.push(silence(1500));
    expect(log).toEqual(['utterance held=false']);
  });

  test('reset withdraws a pending guess', () => {
    const { log, seg } = collectEvents();
    seg.push(tone(600));
    seg.push(silence(500));
    seg.reset();
    expect(log).toEqual([expect.stringMatching(/^tentative/), 'withdrawn']);
  });
});
