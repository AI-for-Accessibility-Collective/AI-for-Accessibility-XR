import { describe, expect, test } from 'bun:test';
import { pcmToWav, trimSilence } from '../src/engine/tts.ts';

const SR = 24_000;
const silence = (ms: number) => Buffer.alloc(Math.floor((SR * ms) / 1000) * 2);
function tone(ms: number, amp = 6000): Buffer {
  const n = Math.floor((SR * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / SR)), i * 2);
  return b;
}
const ms = (wav: Buffer) => ((wav.length - 44) / 2 / SR) * 1000;

describe('trimSilence', () => {
  test('drops the dead air at both ends but keeps a breath', () => {
    const out = trimSilence(pcmToWav(Buffer.concat([silence(300), tone(1000), silence(450)]), SR));
    expect(ms(out)).toBeGreaterThanOrEqual(1000 + 60 + 140 - 25);
    expect(ms(out)).toBeLessThanOrEqual(1000 + 60 + 140 + 25);
  });
  test('never cuts into the speech, including a pause in the middle', () => {
    const out = trimSilence(pcmToWav(Buffer.concat([silence(300), tone(400), silence(500), tone(400), silence(400)]), SR));
    expect(ms(out)).toBeGreaterThanOrEqual(1300);
  });
  test('a clip with no dead air is left the same length', () => {
    const wav = pcmToWav(tone(800), SR);
    expect(Math.abs(ms(trimSilence(wav)) - 800)).toBeLessThan(15);
  });
  test('pure silence and empty clips are returned untouched', () => {
    const quiet = pcmToWav(silence(500), SR);
    expect(trimSilence(quiet)).toBe(quiet);
    const empty = pcmToWav(Buffer.alloc(0), SR);
    expect(trimSilence(empty)).toBe(empty);
  });
  test('keeps the sample rate', () => {
    expect(trimSilence(pcmToWav(Buffer.concat([silence(300), tone(300), silence(300)]), SR)).readUInt32LE(24)).toBe(SR);
  });
});
